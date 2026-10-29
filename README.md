# Gatekeeper

End-of-line reject gate game with a shared scoreboard.

- `index.html`: the game
- `scores.txt`: the scoreboard, one tab-separated line per game (the site appends to it)
- `netlify/functions/scores.mjs`: reads and appends `scores.txt` through the GitHub API

Netlify environment variables: `GITHUB_TOKEN` (fine-grained, Contents read and write on this repo only) and `GITHUB_REPO` (owner/repo). Optional: `GITHUB_BRANCH` (default `main`).
