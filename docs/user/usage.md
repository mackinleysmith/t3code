# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

When a signed-in provider exposes subscription quotas, its summary row keeps the usual cost and
token summary and adds the current five-hour and weekly usage meters. Each meter shows the time
remaining until it resets. On web and desktop, hover a meter to see the exact reset time. Providers
that do not expose quota data omit the meters. Claude also shows model-scoped weekly windows, such
as Fable, when the subscription reports them.

Codex shows `∞` only when the provider explicitly reports unlimited credits. Otherwise it shows
only the quota windows returned for the signed-in Codex plan.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
