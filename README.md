## Install Day-0 Dependency Guard

1. Click **Install**: https://github.com/apps/day0-vulnerability-checker
2. Select your account/org and the repositories to protect
3. In each repo, enable Branch Protection → “Require status checks” → add **Day-0 Dependency Guard**
4. Open a PR that updates dependencies — the app will comment a report and block “Day-0” versions
