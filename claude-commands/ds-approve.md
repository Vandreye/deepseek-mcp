---
description: Review and approve or reject DeepSeek's pending deletes/commands
argument-hint: "[ids to approve | all | reject <ids>]"
---
Call `list_pending_approvals`. If no arguments were given, show the list to the user and stop.
If the arguments name ids (or "all"), call `approve_actions` with those ids. If they start with "reject", call `reject_actions` with the ids after it. Report the results briefly.

Arguments: $ARGUMENTS
