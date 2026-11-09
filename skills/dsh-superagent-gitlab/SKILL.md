---
name: dsh-superagent-gitlab
description: Open and answer merge requests on GitLab with glab, on the branch this ticket already owns.
---

Work in the repository the ticket checked out, and keep to the branch it named, `agent/$DSH_SUPERAGENT_NAME`.

Open the merge request with `glab mr create --no-editor --title "<summary>" --description "<what changed and why, then Closes <issue-key>>" --source-branch "agent/$DSH_SUPERAGENT_NAME"`; the project is the repository you are in, so name neither it nor the target branch unless the Delivery requirements section says otherwise.

Name the merge request's URL in `orchestrator_report`, and mention it when the ticket asks a person a question. The host watches the request from its branch even when the report omits it, but the URL is what a person clicks.

Answer a note on the merge request in its own discussion, not in the Jira issue: `glab api projects/<project>/merge_requests/<iid>/notes -X POST -f body=<text>`, where `<project>` is the repository's path from `glab repo view --output json` or the merge request's own web URL. Keep replies short and specific, and never post credentials, tokens or private Feishu or Jira content.
