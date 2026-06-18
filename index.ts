import { $ } from "bun";

type Config = {
  repo: string;
  authors: string[];
  keyword?: string;
};

async function resolveConfig(): Promise<{ path: string; file: Bun.BunFile }> {
  // Explicit path wins; never fall back if the user named a file.
  const explicit = process.argv[2];
  if (explicit) {
    return { path: explicit, file: Bun.file(explicit) };
  }

  // Try cwd first, then alongside the executable (install location).
  const execDir = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
  const candidates = ["pr-status.yaml", `${execDir}/pr-status.yaml`];
  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) return { path: candidate, file };
  }
  return { path: candidates[0]!, file: Bun.file(candidates[0]!) };
}

const { path: configPath, file: configFile } = await resolveConfig();
if (!(await configFile.exists())) {
  console.error(`Config file not found: ${configPath}`);
  console.error(
    "Usage: pr-status [path/to/config.yaml]   (default: pr-status.yaml)",
  );
  process.exit(1);
}

const config = Bun.YAML.parse(await configFile.text()) as Config;

if (
  !config.repo ||
  !Array.isArray(config.authors) ||
  config.authors.length === 0
) {
  console.error(
    `Invalid config at ${configPath}. Required: repo (string), authors (non-empty list). Optional: keyword.`,
  );
  process.exit(1);
}

const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

const authorFilter = config.authors.map((a) => `author:${a}`).join(" ");
const repoFilter = `repo:${config.repo}`;
const keyword = config.keyword ?? "";

const openQuery =
  `${repoFilter} is:pr is:open ${authorFilter} ${keyword}`.trim();
const mergedQuery =
  `${repoFilter} is:pr is:merged merged:>=${todayStr} ${authorFilter} ${keyword}`.trim();

type SearchIssuesResponse = {
  total_count: number;
  items: Array<{
    number: number;
    title: string;
    html_url: string;
    user: { login: string };
    repository_url: string;
  }>;
};

type PRDetails = {
  data: {
    repository: {
      pullRequest: {
        state: "OPEN" | "CLOSED" | "MERGED";
        isDraft: boolean;
        isInMergeQueue: boolean;
        mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
        reviewDecision:
          | "APPROVED"
          | "CHANGES_REQUESTED"
          | "REVIEW_REQUIRED"
          | null;
        reviewThreads: { nodes: Array<{ isResolved: boolean }> };
        additions: number;
        deletions: number;
      };
    };
  };
};

type Status = "draft" | "merged" | "queued" | "commented" | "approved" | "open";

const STATUS_PREFIX: Record<Status, string> = {
  draft: ":pencil:",
  open: ":pr-open:",
  commented: ":add_comment:",
  approved: ":git-approved:",
  queued: ":merge-queued:",
  merged: ":pr-merged:",
};

async function search(q: string): Promise<SearchIssuesResponse> {
  const out = await $`gh api -X GET search/issues \
    -f q=${q} \
    -f sort=created \
    -f order=desc \
    -F per_page=100`.quiet();
  return JSON.parse(out.stdout.toString()) as SearchIssuesResponse;
}

const [openData, mergedData] = await Promise.all([
  search(openQuery),
  search(mergedQuery),
]);

const seen = new Set<string>();
const combinedItems: SearchIssuesResponse["items"] = [];
for (const item of [...openData.items, ...mergedData.items]) {
  if (seen.has(item.html_url)) continue;
  seen.add(item.html_url);
  combinedItems.push(item);
}

if (combinedItems.length === 0) {
  console.log("No matching PRs.");
  process.exit(0);
}

const detailsQuery = `
query($owner:String!, $repo:String!, $num:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$num) {
      state
      isDraft
      isInMergeQueue
      mergeable
      reviewDecision
      reviewThreads(first:100) { nodes { isResolved } }
      additions
      deletions
    }
  }
}`;

async function getStatus(
  owner: string,
  repo: string,
  num: number,
): Promise<{
  status: Status;
  hasConflict: boolean;
  additions: number;
  deletions: number;
}> {
  const out =
    await $`gh api graphql -f query=${detailsQuery} -F owner=${owner} -F repo=${repo} -F num=${num}`.quiet();
  const parsed = JSON.parse(out.stdout.toString()) as PRDetails;
  const pr = parsed.data.repository.pullRequest;

  const hasConflict = pr.mergeable === "CONFLICTING";

  const status: Status = (() => {
    if (pr.isDraft) return "draft";
    if (pr.state === "MERGED") return "merged";
    if (pr.isInMergeQueue) return "queued";
    const hasUnresolved = pr.reviewThreads.nodes.some((t) => !t.isResolved);
    if (hasUnresolved) return "commented";
    if (pr.reviewDecision === "APPROVED") return "approved";
    return "open";
  })();

  return {
    status,
    hasConflict,
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

const enriched = await Promise.all(
  combinedItems.map(async (pr) => {
    const [owner, repo] = pr.repository_url.split("/").slice(-2);
    const { status, hasConflict, additions, deletions } = await getStatus(
      owner!,
      repo!,
      pr.number,
    );
    return { pr, status, hasConflict, additions, deletions };
  }),
);

const isTestPR = (title: string) => /^\s*test\b/i.test(title);
const totalChanged = ({ additions, deletions }: Item) => additions + deletions;
const bySmallestDiff = (a: Item, b: Item) => totalChanged(a) - totalChanged(b);
const todays = enriched.filter(({ pr }) => !isTestPR(pr.title)).sort(bySmallestDiff);
const tests = enriched.filter(({ pr }) => isTestPR(pr.title)).sort(bySmallestDiff);

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const underline = (s: string) =>
  Array.from(s)
    .map((c) => (c === " " ? c : c + "̲"))
    .join("");

type Item = {
  pr: SearchIssuesResponse["items"][number];
  status: Status;
  hasConflict: boolean;
  additions: number;
  deletions: number;
};

function prefix({ status }: Item) {
  return STATUS_PREFIX[status];
}

function tags({ hasConflict }: Item) {
  return hasConflict ? " (conflict)" : "";
}

function sizeGauge({ additions, deletions }: Item) {
  const total = additions + deletions;
  const thresholds = [1, 50, 200, 500, 1000];
  const filled = thresholds.filter((threshold) => total >= threshold).length;
  return `${"█".repeat(filled)}${"░".repeat(5 - filled)}`;
}

function diffSummary({ additions, deletions }: Item) {
  return `(+${additions}/-${deletions})`;
}

function sizeSuffix(item: Item) {
  return `${sizeGauge(item)} ${diffSummary(item)}`;
}

function plainLine(item: Item) {
  return `${prefix(item)} ${item.pr.title} ${sizeSuffix(item)}${tags(item)} — ${item.pr.html_url}`;
}

function htmlLine(item: Item) {
  return `${escHtml(prefix(item))} ${escHtml(sizeSuffix(item))}${escHtml(
    tags(item),
  )} <a href="${item.pr.html_url}" style="text-decoration: none;">${escHtml(item.pr.title)}</a>`;
}

const sections: Array<{ heading: string; items: Item[] }> = [
  { heading: "Today's PRs", items: todays },
  { heading: "Test PRs", items: tests },
];

console.log("=== terminal view ===\n");
for (const { heading, items } of sections) {
  if (items.length === 0) continue;
  console.log(heading);
  for (const item of items) console.log(plainLine(item));
  console.log();
}

const htmlParts: string[] = [];
for (const { heading, items } of sections) {
  if (items.length === 0) continue;
  htmlParts.push(`<div><b><u>${escHtml(heading)}</u></b></div>`);
  for (const item of items) htmlParts.push(`<div>${htmlLine(item)}</div>`);
  htmlParts.push("<div><br></div>");
}
const html = `<!DOCTYPE html><html><body>${htmlParts.join("")}</body></html>`;

const plainText = sections
  .filter((s) => s.items.length > 0)
  .map((s) => [underline(s.heading), ...s.items.map(plainLine)].join("\n"))
  .join("\n\n");

const stamp = Date.now();
const swiftFile = `/tmp/pr-list-${stamp}.swift`;
const swiftSource = `import AppKit
let html = ${JSON.stringify(html)}
let plain = ${JSON.stringify(plainText)}
let pb = NSPasteboard.general
pb.clearContents()
let htmlOk = pb.setString(html, forType: NSPasteboard.PasteboardType("public.html"))
let textOk = pb.setString(plain, forType: .string)
print("html=\\(htmlOk) text=\\(textOk)")
`;

await Bun.write(swiftFile, swiftSource);

try {
  const result = await $`swift ${swiftFile}`.text();
  console.log("Clipboard set:", result.trim());
  console.log(
    "Rich HTML copied to clipboard — paste into Slack composer for clickable titles.",
  );
} catch (err) {
  console.error("Failed to copy to clipboard:", err);
  const htmlFile = `/tmp/pr-list-${stamp}.html`;
  await Bun.write(htmlFile, html);
  console.error(`HTML available at ${htmlFile} for manual copy.`);
}
