const core = require("@actions/core");
const github = require("@actions/github");

async function run() {
  try {
    const message = core.getInput("message");
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      throw new Error("GITHUB_TOKEN is not available");
    }

    const octokit = github.getOctokit(token);
    const context = github.context;

    if (!context.payload.pull_request) {
      core.info("Not a pull request event. Exiting.");
      return;
    }

    const { owner, repo } = context.repo;
    const issue_number = context.payload.pull_request.number;

    const files = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: issue_number,
    });

    const changedFiles = files.data.map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
    }));

    const totalAdditions = changedFiles.reduce((s, f) => s + f.additions, 0);
    const totalDeletions = changedFiles.reduce((s, f) => s + f.deletions, 0);

    const extensions = new Set(
      changedFiles.map((f) => f.filename.split(".").pop()).filter(Boolean)
    );

    const body = `
    ## 🤖 Sentinel Review
    
    **Files changed:** ${changedFiles.length}  
    **Lines:** +${totalAdditions} / -${totalDeletions}  
    **File types:** ${[...extensions].join(", ")}
    
    _Status: Static analysis only (AI offline)_
    `;

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body,
    });

    core.info("PR comment posted successfully");
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
