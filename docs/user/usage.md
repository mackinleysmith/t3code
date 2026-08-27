# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

When a signed-in provider exposes subscription quotas, its summary row keeps the usual cost and
token summary and adds the current five-hour and weekly usage meters. Each meter shows the time
remaining until it resets. On web and desktop, hover a meter to see the exact reset time. Providers
that do not expose quota data omit the meters. Claude also shows model-scoped weekly windows, such
as Fable, when the subscription reports them.

Codex shows only the quota windows returned for the signed-in plan. Recent Codex sessions can
supply the same account-accurate snapshot without another provider request; otherwise T3 Code asks
the local Codex CLI. If a refresh fails, the last successful meters remain visible with their age
until a later refresh succeeds.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
