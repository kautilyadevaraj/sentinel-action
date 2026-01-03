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

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body: message,
    });

    core.info("PR comment posted successfully");
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
