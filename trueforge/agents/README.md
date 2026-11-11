# Agent definitions

`main.agent.json` (agent mode) and `inline.agent.json` (inline edit) are the manifests from blueprint section 6, in TrueForge's wire format (the create-agent page's field names).

- `model.name` is the placeholder `<provider>/<model>`. The real model comes from the active profile at runtime (`swage.models`, or `config/models.json` for `npm run setup`).
- `npm run setup` creates or updates one TrueForge agent per profile: `swage-main-<profile>` and `swage-inline-<profile>`, for example `swage-main-primary`. Fallback profiles differ only in `model.name`.
- `submit_change_set` and `run_command` pause for approval by name, so the review does not depend on tool labels.
- Five hot tools are preloaded; `run_tests`, `get_symbol`, `repo_map` and `run_command` stay deferred, so deferred loading is visible in the session.
- The inline agent can only call `declare_context` and `stage_edit`, and stops after 8 iterations.
