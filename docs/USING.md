# Using the Panel

> Operator guide: what each part of the panel is for, how to send invitations and campaigns, and how to
> read the numbers. For design decisions and the Redis key map see [`architecture.md`](architecture.md);
> for deploy and server operations see [`DEPLOYMENT.md`](DEPLOYMENT.md) and [`runbook.md`](runbook.md).

## The 60-second model

Five objects, one of which is a job:

| UI | What it actually is | Why it exists |
|---|---|---|
| **Google accounts** | A connected calendar **and** a sending mailbox, with its own limits | Creates the calendar events and receives the RSVP updates |
| **Contact lists** | An uploaded list, sorted into groups, plus the memory of who was already invited | Decides who gets invited, and stops repeat invitations |
| **Calls** (video calls) | A real event — usually a Zoom meeting — and its attendance report | Turns "they said yes" into "they showed up" |
| **Campaigns** | A durable job that binds a list + event + mailboxes (+ optional video call) | Sends a large audience over several days, paced, with per-person state |
| **Invitations** | A one-off send, right now | Small or urgent sends that do not need a job |

The flow is always the same shape:

```
Google accounts (who sends) + Contact list (who receives) + Event details
        └──► Campaign (or a one-off Invitation)
                 └──► calendar invites go out, paced per mailbox
                          └──► replies are mirrored to GoHighLevel
                                   └──► attendance is pulled from Zoom
                                            └──► Campaign CRM joins reply + attendance + notes per person
                                                     └──► Statistics rolls it all up
```

## The other tabs

- **Documents** — brand and product notes the AI reads when it sorts a list or drafts an invitation. Better
  documents make better groups and better copy.
- **Campaign CRM** — a per-person workbench for one campaign: RSVP, Zoom attendance, sending account, copy
  variant, campaign notes and follow-up. Every campaign also has the same view under **Details → People**.
- **Deliverability** (owner/admin) — what the internet can verify about the domains behind your sending
  accounts: SPF, DKIM, DMARC, MX and public domain blocklists.
- **Assistant** (owner/admin) — reviews recent activity and proposes changes you can apply.
- **People** (owner/admin) — team accounts and roles. This is different from **Campaign CRM → People**:
  one manages panel users, the other manages the humans on a campaign. Members can browse the product;
  campaign actions are owner/admin.
- **Settings** — AI provider/key, Zoom mode and hosts, security, and branding.

## Before anything works

A campaign needs two things before it can even be created. The Campaigns tab says which one is missing
and links straight to the fix:

1. **At least one active Google account.** Without a mailbox there is nothing to send from.
2. **At least one sorted contact list.** A campaign reads the list's segmentation result to decide who to
   invite, so an unsorted list cannot start. Sorting uses the AI key from **Settings → AI**.

Optional, but this is where the value compounds:

- **Zoom** (Settings → Video conferencing, plus a Zoom host per campaign) for attendance.
- **GoHighLevel** on the Google account (Automations) so replies and attendance land in your CRM.

## Set up once

### Google accounts

1. **Google accounts → New connection**: give it a name, the calendar id and your GHL location id, then
   **Connect Google** (OAuth) or use a service account. Paste a GHL private token instead of OAuth if that
   is how your account is set up.
2. The account becomes a **sender**: it appears on the Invitations and Campaign screens with the other
   mailboxes.
3. The Campaigns tab needs at least one account in `active` state before it will let you create a campaign,
   and every campaign also has a per-account on/off switch for who actually sends.

### Sending accounts

This is where the mailbox limits live (`owner`/`admin` only; visible to everyone while auth is off):

| Field | What it controls |
|---|---|
| max per day | Hard ceiling for that mailbox per day, across **all** campaigns and one-off invites. One send is one blast, up to this many recipients |
| pause between batches | Minimum gap between send passes, so traffic is never back-to-back. It never splits one blast |
| warm up slowly | Starts at a lower daily cap and raises it day by day up to max per day |
| sending hours | Weekdays + hours + timezone in which **campaigns** may send |
| sending domain | The domain this mailbox sends from. Blank means auto-detect from the calendar |
| DKIM selector | The selector to check. Blank probes `google` and other common Workspace selectors |

Each account sends **one Calendar event per blast**, with every recipient it is allowed to contact that
day on it. If the audience is larger than max per day, the rest goes out in the next blast on the next
day. Google's guest-list ceiling is the only thing that can split a single blast.

The last two fields exist for calendars Google will not name: a **primary** calendar, or a shared/resource
calendar (`*.calendar.google.com`). Leave them blank for ordinary `owner@yourdomain.com` calendars — the
domain is read from the address. If the domain still cannot be worked out, Deliverability lists the account
and links straight back here.

If a mailbox keeps failing, it rests automatically for a while (a **cooldown**) and campaigns move its
queue to healthier mailboxes. You can also pause it by hand, or use **Send now** to bypass the pacing for
one manual batch — caps and cooldowns still apply.

### Contact lists

1. **Contact lists → upload** a CSV, then let the AI **sort it into groups** (segments).
2. Review the groups. Campaigns and one-off invites let you pick groups; leaving them all unchecked means
   the whole list.
3. The list remembers everyone it has ever invited (`list:{id}:invited`). That memory is shared by every
   campaign and every one-off invite that uses the list.

Deleting a list leaves campaigns that reference it unable to start — they lose their audience.

### Calls

**Calls → + Add call** creates the event record: title, optional join link (Zoom is looked up if you leave
it blank), start/end, the Google account it belongs to, an optional Zoom host, and an optional link back to
an invitation.

Attendance syncs on its own after the call, and **Sync** forces a refresh. **View results** shows who
joined and who did not. **Send results** runs the account's after-call actions and sends the results to
GHL. The call opens in four tabs: **People**, **Polls & Q&A**, **Registration** and **Workflows**.

A call linked to a campaign inherits that campaign's **frozen recipients** as its invited list, so
attendance matches the people who were actually emailed. A standalone call has no invited list: people who
joined appear as **Walk-ins**, and no-show counts stay empty until the call is linked to a campaign or an
invitation.

If Zoom has no report yet — normal for a while after a webinar ends — the call shows **Waiting** and the
panel retries hourly for up to 24 hours. Nothing is stored as “0 attended” in the meantime.

If it stays waiting, open **View results → What the last sync tried**: each attempt shows the call type,
the Zoom host that asked, the HTTP status of the report and of the past-call fallback, and Zoom's own
message. **Edit call** corrects the type, ID or host without deleting the call, and saving re-syncs
immediately. The panel also retries the other call type and the other connected hosts on its own when the
first answer is a 404.

### After-call actions

Open **Calls → After-call actions** or **Google accounts → ⋯ → After-call actions**. The settings apply to
every call on that account.

Each person gets one result:

| Result | Meaning |
|---|---|
| Attended | Invited and watched at least the minimum minutes |
| Brief visit | Invited and watched less than the minimum |
| No-show | Invited but never joined |
| Walk-in | Joined but not on the invited list |

The dialog has three parts:

1. **Label results in GHL** — one tag per result, plus an optional GHL custom field that receives
   `Attended`, `Brief visit`, `No-show` or `Walk-in`. A blank Brief visit tag falls back to the Attended
   tag, so existing workflows do not change.
2. **Add people to workflows** — the workflows this account may use, and the rules that choose one.
   AI matching is optional and lives here too.
3. **Send the call report to a webhook** — one POST per call with everyone in the report in one flat
   list. Each person carries `result` (`attended`, `partial`, `no_show` or `not_invited`). Leave the
   URL blank to turn it off.

**Advanced** holds how tags are sent (API, webhooks or both), per-person webhooks, and developer
examples. These are still fully editable; they are collapsed because most accounts do not use them.

**Send results** runs everything configured: tags, per-person webhooks, workflow rules, AI matching and
the call report. It runs automatically after a successful sync too. **More → Send call report** sends
only the call report, even when its content is unchanged.

The call report defaults to **One flat list of everyone**. Two older formats remain available for
consumers that already expect them: **One request per result group** (`attendance.segment`) and **One
request, grouped by result** (`attendance.session`). A connection keeps whichever format it already has
until you change it.

The invited list is cross-referenced automatically: a campaign-linked call uses the campaign's sent
recipients, a one-off invitation uses the attendee list of the calendar event it created, and a standalone
call can name a list with **Edit call**. If none is linked, everyone who joined is a walk-in and no
no-shows are invented.

### Routing attendees into workflows

In **After-call actions → Add people to workflows**, connect each GHL workflow this account may use: give
it a name for this panel and paste the workflow ID (the part after `/workflow/` in the GHL workflow URL).
The name is only for you; the ID is what GHL receives.

Then add **workflow rules**. Rules are checked from top to bottom and the first enabled match wins, so put
the narrowest rule first. Every normal condition and every poll condition must match:

- Normal conditions use the attendance catalog — result, invited source, minutes, engagement, attendance
  percentage, poll count/answers, Q&A, registration answers, joined-late/left-early, device/location/
  network and the call fields.
- Poll conditions target one poll question: **answered**, **did not answer**, **answer is**, **answer
  contains**, **answer is not** or **answer does not contain**. “Did not answer” only fires when that
  question actually ran in the call, so a poll you forgot to launch does not match everyone.
- A rule with no conditions matches everyone. That is useful as the last rule and dangerous as the first.

**Start workflow at** is either **Now** or **When the call started**. It is the timestamp GHL uses for
time-based workflow steps.

Open a call's **View results → Workflows** tab to review matches before anything is added.
**Review workflow matches** shows what the rules and, if enabled, AI would do. Tick the rows you want and
press **Add selected to workflows**. Already-applied workflows are skipped; one workflow per person per
call is the default. To add a second one deliberately, use **Add someone manually** and confirm.
**Make this a rule** on a poll answer opens After-call actions with a pre-filled poll rule.

AI matching is optional and off by default. Add a short “When should AI pick this?” note to each workflow,
then turn on **Let AI choose workflows**, choose **Review first** (recommended) or **Apply automatically**,
and pick **Low / Medium / High** confidence. If you want a cost cap, set **Limit AI to** a number of people
(default 25; 0 = everyone; the first N unmatched in attended → brief visit → no-show → walk-in order). The
model only sees anonymous `p1`, `p2`, … rows and the behavior above — not the attendee name/email fields —
and it can only choose from the workflow IDs you added. Free-text poll, Q&A and registration answers are
sent as the attendee typed them, so treat AI matching as a data-sharing decision. With **Review first**
nothing is applied until you review it; **Apply automatically** adds only matches at or above the chosen
confidence. AI runs after the deterministic rules, and only for people those rules did not match.


### Replies in GoHighLevel

RSVP handling is configured **per Google account**, not per campaign: **Google accounts → Automations** on
the connection. There you choose how replies are delivered (direct API, workflow webhook, or both) and map
yes / maybe / no to appointment statuses, tags, DND and webhooks. Every campaign on that account inherits
the same mapping.

## Two ways to invite: one-off vs campaign

| | **Invitations** (one-off) | **Campaigns** |
|---|---|---|
| Timing | Sends now, or in scheduled rounds | Now, or on a timer |
| Size | Up to 300 per account per round (optional) | Any size — spread over days |
| Pacing | Mailbox caps only; **sending hours are ignored** | Caps + sending hours + batch delays + warm-up |
| Progress | A result summary (`sent`, `scheduled`, `unplaced`) | Per-recipient ledger, progress bar and per-mailbox counts |
| After it starts | Pause or cancel a scheduled batch | Pause, resume, send a batch, change the stop time, end |
| Repeat invites | Checkbox, with a count of who it affects | `includeAlreadyInvited` on the campaign |
| Reporting | History table | Full funnel + per-mailbox attribution + attendance |
| Use it when | "Send this now to the people I can reach today" | "Invite 3,000 people over the next week, safely" |

A one-off send **spends the same mailbox budget** a campaign would: the daily counter is keyed by
mailbox, not by feature.

## Sending a one-off invitation

1. **Invitations** → tick the Google accounts that should send. Each shows what it can still send today.
2. Fill in the event: title, description (or **Draft with AI**), start, end, timezone, location/link.
3. Pick the contact list and, if you want, specific groups. The preview shows exactly who will receive it.
4. If anyone on that list was already invited, a **“Also invite people who were already invited”** checkbox
   appears with a count and the previous event they were invited to. Leave it off unless you mean it.
5. **Send in batches** (optional): tick it, set **Recipients per account per round** (default 300) and
   **Wait between rounds** (hours). The first round goes out immediately; the worker sends the later rounds.
6. **Preview**, then **Send invitations**.

The result tells you what went out and what could not be placed today. Nothing is recalled once sent.
Each account sends one event with its share, so a guest receives a single, unnumbered invitation. The
only numbered split is Google's guest-list ceiling.

### Sending a one-off in rounds

A round is **one event per selected account**. With three accounts and 300 recipients, a round invites up to
900 people; the panel then waits the delay and sends the next round. The history shows the schedule with
**Pause**, **Resume** and **Cancel**, plus the next round time and how many people are still waiting.

- The 300 is a ceiling **on top of** the mailbox cap. An account with 100 left sends 100 this round and the
  rest waits, so rounds take longer than the caps alone would.
- Rounds stop at the event start. Anyone left at that point is reported as not invited.
- The invited set is re-checked every round, so someone invited elsewhere in the meantime is skipped.
- A failed event's recipients stay queued for the next round.
- Batching off (the default) means one event per account, with every recipient that account can send today.

## Running a campaign

Creating, starting, pausing, ending and deleting a campaign is limited to **owner/admin**; other roles can
open the tabs and read the numbers. (With auth disabled everyone is effectively an owner.)

### 1. Create it

**Campaigns → New campaign**:

| Field | What to put there |
|---|---|
| Name this campaign | Anything you will recognise later, e.g. "November webinar blast" |
| Which contact list? | The list whose segmentation supplies the audience |
| Which video call? | Optional: makes the join link and attendance part of this campaign |
| Zoom host for this campaign | Optional with zero or one host connected. With several hosts, pick one — sync cannot guess which account to read |
| Timezone for the calendar invite | The timezone guests will see |
| Which groups to include | Empty means the whole list |
| Also invite people who were already invited | Off by default; see the rules below |
| Start sending | **As soon as I press Begin sending**, or **At a specific time** |
| Stop sending by (optional) | A hard deadline; presets add +1 day / +3 days / +1 week |
| Send in batches | Optional: a round creates one event per active variant per account, then waits |
| Round size per account / wait between rounds | Appear when batching is on; defaults 300 and 24 h |
| Test different copy (unlimited variants) | Optional: A is the subject/description above; add B, C, D, E… to split the audience evenly |
| Who this will reach | Live count, already minus anyone invited before |
| When it will finish | Live estimate from the selected mailboxes and their caps |
| Email subject / Description | What the invitation says |
| Event starts / Event ends | The actual event, not the send window |
| Which accounts send, and how much | One or more mailboxes. Each checked account gets a percentage of the audience; the checked rows add up to 100%. |
| Max (optional) | Caps that account for the whole campaign. People above the cap flow to the other checked accounts. |

**How the split works.** Each checked account receives its percentage of the frozen audience. Percentages
auto-balance: editing one row reshuffles the other checked rows, and **Split evenly** resets them. Set a row
to 0% (or uncheck it) to leave that account out. For example, 1,240 people split 60/40 means roughly 744 and
496; if the 60% account has **Max** 300, it receives 300 and the remaining 940 go to the other accounts. If
every account hits its Max and people are still left, the wizard warns you before you create the campaign.

The split freezes when you press **Begin sending**. If a mailbox fails later, its remaining people are moved
evenly to the healthy accounts, so the original percentages describe the first assignment, not every later
move. **When it will finish** uses the same per-account assignment, so a slow 90% mailbox is not hidden by a
fast 10% mailbox.

**Who this will reach** and **When it will finish** are computed with the same code the send uses, so the
numbers you approve are the numbers that get frozen. If the estimate lands after your deadline, add a
mailbox, raise a cap, or move the deadline — before starting.

If **Send in batches** is on, the estimate also shows roughly how many rounds there will be and when the last
one starts. It assumes every account can send its full per-round amount, so a lower cap makes the real finish
later — the note says so.

### Testing copy (unlimited variants)

Tick **Test different copy (unlimited variants)** in the campaign wizard to add alternates to the
subject/description above (variant A). On **Begin sending**, recipients are split as evenly as possible
across all variants and each active variant gets its own calendar event per account. With batching, the
per-event limit is shared across the variants, so N variants on one account produce N smaller events in
that round. There is no four-variant ceiling: add as many as you like (A, B, …, Z, AA, AB, …).

Each variant can also carry its own optional **Zoom registration link**. Paste it in the variant row, or
in **Variant A**'s own field. That variant's calendar event uses the link as its location; blank falls
back to the campaign's linked call link, then to the event's manual location. This is how you send
different copy to different registration pages.

Registration and attendance are still read from the campaign's **one linked call**, so per-variant
registration counts exist only when the links lead to separate Zoom sessions (or carry Zoom source
tracking). The panel does not invent per-variant registration numbers.

Open **Campaigns → Details** to see every variant and **Send test copy**. A test:

- is a real Google Calendar invite to 1–5 addresses, titled `[TEST] <subject>`;
- uses the same time and copy as the real variant, and that variant's registration link (or the
  campaign's linked call link when it has none);
- does **not** enter the queue, mark anyone invited, or appear in the campaign stats;
- leaves a `[TEST]` event on the sending account's calendar, and its RSVPs are ignored by the sync pipeline.

Campaign Details also shows **What happened, per copy variant**: sent, yes/no/maybe/no reply, attendance (once
the call is synced), RSVP rate and acceptance rate. The app has no open/click tracking, so choose a winner
yourself from those numbers — there is no automatic winner.

Variants are fixed when sending starts. While a campaign is a draft or scheduled, **Details → Edit copy** lets
you add, remove or change any variant; once the audience is frozen, the copy is locked.

**Create campaign** saves it as a draft — or as **Scheduled** when you chose a later start. Nothing is frozen
yet either way, and every field can still be changed.

### 2. Start it — the freeze

**Begin sending** (on the card, or automatically at a scheduled time) does four things:

1. Freezes the audience from the list's sorted result, minus anyone already invited for that list.
2. Splits the people across the selected mailboxes by percentage/quota, interleaving them so each mailbox's
   queue is mixed rather than a contiguous block.
3. Writes one recipient row per person (`pending`) and one queue per mailbox.
4. Switches the campaign to **Sending**.

The toast reports the real numbers — e.g. *"2,431 people added to the queue (312 were skipped as already
invited)"*. If the audience is empty, the campaign refuses to start and tells you why.

From then on the background scheduler sends. You do not need to keep the panel open.

### 3. Watch it

Each card shows a progress bar, `Sent X of Y · Z still waiting · N accounts`, a status chip, and — when
something fails — a `N didn't go through` chip. With batching on, a **Next round** chip shows when the next
round opens. **Details** opens the funnel and the per-mailbox breakdown.

## Controlling a campaign

| Status (chip) | Meaning | Buttons on the card |
|---|---|---|
| **Not started** (`draft`) | Nothing frozen; edits still allowed | Begin sending · Schedule |
| **Scheduled** | Waiting for its start time. The audience is frozen only when it activates, so anyone invited elsewhere in the meantime is skipped | Begin now · Cancel schedule |
| **Sending** (`active`) | The scheduler is working through the queues | Pause · Send a batch |
| **Paused** | Scheduler skips it; queues are untouched | Resume · Send a batch |
| **Finished** (`completed`) | Every queue is empty | Details only |
| **Ended** | Stopped for good; nothing more will send | Details only |

The `⋯` menu holds the occasional actions: **Add / Change Zoom host**, **Add / Change stop time** (both only
while the campaign is live), **End sending**, **Delete**.

- **Pause** stops new sends immediately. Nothing is lost, and a batched campaign keeps its next round time.
- **Send a batch** runs one manual pass for that campaign (up to the mailbox's daily headroom, or the
  campaign's per-round limit when batching is on). It skips the "pause between batches" delay, but the
  daily cap, sending hours and cooldowns still apply. While a batched campaign is between rounds, it
  refuses and tells you when the next round opens. Before sending, stranded work on a paused, cooling
  or campaign-disabled account is moved to a healthy account. If nothing is sent, the banner names the
  blocker for each account (paused, outside sending hours, daily cap, cooling, off for this campaign,
  or nothing queued) instead of only saying "Sent 0".
- **End sending** asks for confirmation and tells you how many people will never be invited. It is **not a
  recall**: invitations already delivered stay in people's calendars.
- **Delete** removes the campaign and its per-recipient history. Use **End** if you only want it to stop.

## How the sending pace actually works

You set the ceiling; the scheduler decides the moment-to-moment order.

- **Caps belong to the mailbox.** Every campaign and one-off invite using that mailbox shares the same daily
  counter. Two concurrent campaigns split one budget; they do not double it.
- **A campaign's percentages only split it internally** — they decide who in *this* campaign sends which
  slice, not what the mailbox sends overall.
- **Sending hours** (on the sending account) gate campaigns. Outside them, nothing is sent, and the work
  simply waits for the window.
- **One blast per account.** The daily headroom goes on one Calendar event (one per active copy variant).
  There is no hidden 100- or 200-recipient split; the next event only happens when the daily cap reopens.
- **Batch delays** keep send passes from being back-to-back. **Warm-up** raises a new mailbox's daily cap gradually.
- **Batched rounds add a second ceiling.** A batched one-off or campaign sends at most the per-round limit
  from each account, then waits. The daily cap still applies, so a 100/day cap with a 300 round sends 100
  in that round and takes longer than the caps alone would. Rounds never start at or after the event.
- **One mailbox is one resource.** When several campaigns share it, each gets a fair slice of the allowance,
  then leftover capacity flows to the priority order — a huge campaign cannot starve a small one.
- **Failures are retried in front of the queue**, so a temporary error does not push someone to the back of
  the line. Repeated failures put the mailbox into a cooldown, and its queued people are moved to healthy
  mailboxes in the same campaign.
- **The campaign finishes on its own** when every mailbox's queue is empty.

## Rules that surprise people

1. **A person is invited once per contact list, not once per campaign.** The invited set is shared with the
   one-off Invitations path. A second campaign on the same list therefore has nothing to send — that is the
   filter working, not a bug.
2. **Re-inviting is always opt-in.** It emails people again and creates a second calendar event. Enable it
   deliberately (campaign checkbox or the one-off checkbox).
3. **A stop time does not unsend anything.** It ends sending. Anyone still pending stays pending, stays
   *uninvited*, and can be picked up by a later campaign.
4. **Ended ≠ deleted.** Ending keeps the recipient history and the honest pending count. Deleting removes it.
5. **The audience is frozen when the campaign activates**, not when you schedule it. That is what lets the
   dedupe set catch people invited elsewhere in the meantime.
6. **A scheduled campaign that finds an empty audience** at activation is paused with a visible reason,
   rather than silently retrying every minute.
7. **A deadline that lapses before a scheduled campaign ever starts ends it** instead of activating it —
   freezing an audience that is no longer allowed to receive anything is wasted work.
8. **Deleting supporting objects breaks references.** Deleting a list leaves campaigns that cannot start;
   deleting a video call removes its attendance record and the join link from future invitations.
9. **A campaign is one event, one webinar, one Zoom host.** Need a second event? Create a second campaign.
10. **A batched send stops at the event start.** No round begins after it; anyone left stays uninvited and is
    reported in the schedule's error line.
11. **A round is one event per account, not one event overall.** Without copy variants, three accounts create
    three events per round, each with its own event ID; attendance reads all of them. Each active variant adds
    another event per account.
12. **Copy variants add events, not recipients.** Each active variant gets its own event, so N variants on three
    accounts can create up to 3N events in a round; the total recipients per account per round is unchanged.
    There is no four-variant limit.
13. **A test copy does not count as an invitation.** It sends a real `[TEST]` calendar invite but never enters
    the queue, the invited set or the campaign stats; its RSVPs are ignored by the sync pipeline.

## Reading the numbers

### On a campaign

The card gives the headline (`Sent X of Y`, `Z still waiting`, failed count). **Details** opens the funnel:

```
invited → sent / failed / still queued
        → accepted / declined / maybe / no reply
        → attended / no-show        (only with a linked video call)
```

Everything is broken down **per sending mailbox**, because every recipient row remembers which account
created the calendar event.

### Campaign CRM (People)

The CRM answers the next question after the funnel: **what should I do about this person?** It joins the
frozen recipient, the Google RSVP, the linked Zoom report, the campaign note and the RSVP history on one
row. Open it from **Details → People**, from the **People** action on a campaign card, or from the
**Campaign CRM** item under *Insights* (which adds a campaign picker).

The tab shows 10 people at a time; the full view shows 50. Both use the same rows and filters.

| Column | What it means |
|---|---|
| Person | Zoom display name, then the name from the source list, then the email |
| Reply | Yes / No / Maybe / No reply; **Not sent** means no invitation was delivered |
| Zoom | Attended / Brief visit / Didn't join / Walk-in / Not tracked / Not invited |
| Follow-up | None / To contact / Contacted / Done, from the campaign note |
| Sender | The Google account that created this person's invitation |
| Copy | The copy variant used for that invitation |
| Sent | Delivery state and time |
| Activity | Call minutes, polls answered, Q&A and registration answers |

Expand a person for campaign facts, RSVP history, the note editor and the same Zoom behavior panel used
by **Calls**. The five rules that matter:

- **Reply and attendance are separate axes.** "Said yes but didn't join" is a real, filterable combination;
  it is not hidden inside a single status. Use **Reply = Yes** + **Zoom = Didn't join**.
- **Pending and failed are not no-shows.** People who never received an invitation show **Not invited** for
  Zoom and **Not sent** for Reply. They never inflate the no-show count.
- **Walk-ins are separate.** Someone who joined without being on the campaign's list appears with a
  **Walk-in** chip. They are counted separately and do not inflate the invited/RSVP denominators. A
  walk-in without an email can still be annotated by name.
- **Filters apply to the table, not the summary.** The summary strip always describes the whole campaign,
  so filtering to one person does not rewrite the campaign totals. **Search** covers name, email, company
  and phone; the other filters cover reply, Zoom result, send state, sending account, copy and follow-up.
- **A missing or stale report is called out.** A campaign with no linked call, a call without a Zoom report,
  or a report synced before the latest invitations gets a warning. **Open call** opens the call's results
  so you can sync it.

Notes are **campaign-scoped**: the same person can have a different note in another campaign. They allow up
to 2,000 characters and store who changed them and when. Any signed-in panel user who can reach the view
may edit them; sending remains owner/admin. Clearing both the note and the follow-up deletes the record.

RSVP history starts **when this version is deployed**. Google does not expose response timestamps, so the
first observation is labelled **Tracking started**, and later entries say **Changed to …** with the time
our sync detected the change. There is no backfill and no invented reply time. History is capped at the
last 20 changes per person.

**Export CSV** downloads **every row matching the current filters**, not just the visible page, with the
reply, full RSVP history, Zoom behavior, campaign facts, note and follow-up. The file is a normal CSV
attachment and opens in Excel, Numbers or Sheets.

### On the Statistics tab

Statistics rolls **every campaign and video call** into one view for the last **7, 30 or 90 days**:
invitations per day, the reply mix, results per sending account, and the top campaigns.

Two deliberate details:

- **Invitations are windowed by when they were sent; replies and attendance are not re-windowed.** A campaign
  that sent inside the period contributes its whole funnel, so "accepted" never contradicts "sent".
- **“Still waiting” and “failed” are current state**, not period state — something waiting today is waiting
  regardless of which period you pick.

A brand-new account shows **labelled sample data** so the page is not a wall of zeros. The banner says
“Sample data — nothing here is real.”; it is generated in the browser, never stored, and disappears the moment
real invitations or video calls exist. An established account with an empty period shows honest zeros instead.

### Exporting the numbers

**Export ▾** on the Statistics tab downloads one table at a time, as **CSV** (opens in Excel, Numbers
or Sheets) or **JSON**:

| Export | One row per |
|---|---|
| Summary | the chosen period — totals, reply mix, rates |
| Invitations per day | day |
| Campaigns | campaign — full funnel and rates |
| Campaigns × sending account | campaign and mailbox |
| Campaigns × copy variant | campaign and copy variant |
| Zoom calls | call — latest sync, attendance, polls, Q&A |
| Sending accounts | mailbox — totals for the period |

- **Period** is either this page's period or **All time**. Campaign and call exports default to all
  time; the three overview exports always use the page period.
- **Only this campaign / Only this call** narrows a campaign or call export to one record.
- Campaign **Details → Export stats** and **Calls → More → Export call stats** open the same dialog
  preselected to that record.
- A call export reflects its **latest sync**. Older sync attempts are not kept, so there is no sync
  history to download.
- Attendance cells are **blank** when a campaign or call has no attendance data — never a fake zero.
  Timestamps are ISO 8601 (UTC) and percentages are plain numbers.

### What the words mean

| Word | Means |
|---|---|
| Invitations | Recipient rows actually sent in the period — the same person in two campaigns counts twice |
| Accepted / Declined / Maybe | The RSVP on the calendar invitation |
| No reply | Invited, but no answer recorded |
| Attendance | Sent recipients Zoom reported as attending |
| No-show | Invited, but Zoom did not report them as attending; pending/failed recipients are excluded |
| Walk-in | Joined the linked call without being on the campaign's invited list |
| Not tracked | Invited, but the Zoom report has no row for them (the report is missing or stale) |
| Not invited | Pending/failed — no invitation was delivered, so this is not a no-show |
| Follow-up | A campaign-scoped note state: None, To contact, Contacted or Done |
| Tracking started | The first RSVP value we observed; not a Google reply timestamp |
| Acceptance rate | `accepted ÷ sent` |
| Campaign attendance rate | `attended ÷ (accepted + maybe)` — of the people who said they would come |
| Statistics attendance rate | `attended ÷ (attended + no-show)` — of the outcomes Zoom actually reported |

Numbers can differ between a campaign and Statistics without either being wrong: different windows,
different denominators, and a person can appear in more than one campaign.

Open and bounce rates are deliberately absent — the campaign CRM tracks replies, attendance and follow-up,
but no email open or bounce signal exists. RSVP answers are the reply signal.

## Checking a domain (Deliverability)

**Deliverability** (owner/admin) answers one question: what can the internet verify about the domains your
sending accounts use? It is informational and never blocks a campaign.

One card per domain, deduped across accounts, with a badge for each check:

| Check | Passes when |
|---|---|
| MX | The domain has at least one real mail server |
| SPF | One record, includes `_spf.google.com`, ends in `-all`, and stays inside the 10-lookup limit |
| DKIM | A usable key is published at the account's selector (or any common Google/Workspace selector) |
| DMARC | `p=quarantine` or `p=reject` at `pct=100` |
| Blocklists | Clean on Spamhaus DBL and SURBL (an unreachable resolver shows as *unavailable*, not *listed*) |
| MTA-STS / BIMI | Shown for information; they never change the overall status |

**Check all** and **Check now** query DNS immediately. Opening the page only reads the cache, which lasts six
hours by default (`DOMAIN_HEALTH_CACHE_MINUTES`). Only sending-account domains are checked — there is no
separate list of domains to maintain.

Consumer domains (`gmail.com`, `outlook.com`, `yahoo.com` and similar) show **Managed by Google**. Their checks
are displayed for information but are never treated as something you can fix. Accounts whose calendar hides
the domain (`primary`, or a `*.calendar.google.com` resource calendar) appear under **Accounts without a
sending domain**, with a link back to Sending accounts.

What this page cannot tell you: inbox placement, a Google Postmaster score, or how Google's sending IPs are
regarded. Google sends these invitations from its own infrastructure, so an IP blacklist would test Google,
not your domain. A published DKIM key also only proves the key exists, not that Google signs with it — send
yourself a Gmail test if that matters. DMARC is checked on the exact sending domain; a record on a parent
domain is not inferred.

If a selected sender's domain needs attention, the campaign wizard adds a non-blocking note with the top
findings and a link here. Sending is never stopped by it.

## Common scenarios

**"Invite 5,000 people over two weeks from three mailboxes."**
Sorted list → campaign with all three mailboxes, split evenly → check *When it will finish* → start now.
Monitor the progress bar once a day; nothing else is needed.

**"It must finish before Friday."**
Set *Stop sending by* Friday in the wizard. If the estimate says it will not make it, add a mailbox, raise the
daily cap, or narrow the groups. Starting anyway is fine — the campaign simply ends on Friday with people
left pending, and they stay uninvited for a follow-up campaign.

**"This list was already invited last month for another event."**
The audience preview will show 0. Tick *Also invite people who were already invited*; the toast reports how
many were repeat invitations. Do not create a new list just to bypass the memory.

**"A mailbox got rate-limited mid-campaign."**
Leave it alone. It cools down, its queue moves to the healthy mailboxes in the same campaign, and it refills
on its own afterwards. Pause the campaign only if you want to stop everything.

**"Two campaigns need to run at the same time."**
Fine — they share the mailboxes' budgets. Expect each to take roughly twice as long as it would alone; the
planner in each wizard already accounts for the caps, so trust *When it will finish*.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Campaigns tab says "No Google accounts linked yet" | No active account | Connect one under **Google accounts** |
| Campaigns tab says "No contact lists ready yet" | No list has been sorted | Upload a list and run segmentation |
| "list has no segmentation result" when starting | The list was never sorted (or the sort failed) | Sort the list, then start again |
| Begin sending refuses: audience empty | Everyone was already invited, or the chosen groups are empty | Enable re-inviting, or pick a different list/groups |
| Campaign is "Sending" but nothing goes out | Outside sending hours, caps already used by another campaign, or the mailbox is paused/cooling | Check **Sending accounts**; wait for the window or add a mailbox |
| `N didn't go through` chip | Some recipients failed (bad address, provider refusal) | Details shows the error per recipient; failures re-queue automatically |
| Scheduled campaign is Paused with a reason | Its audience was empty at activation | Fix the audience, then Resume |
| Attendance sections are empty | Zoom reports not readable, or the call has not happened | **Calls → Sync**; if it stays empty, Settings → Video conferencing → **Check access** |
| Synced, but 0 attended while View results lists people as Walk-ins | The call has no invited list linked | Link it to the campaign or invitation that sent the invitations, then Sync. Campaign-linked calls pick this up automatically |
| “Zoom has no report for this call yet”, or the call stays Pending with `HTTP 404` | Zoom has no past call under that ID, type or host | Press **Edit call**, set the right **Type of call**, paste the numeric ID or join link, pick the hosting Zoom account, then save. The panel also tries the other type and other hosts automatically |
| Call stays Waiting and View results shows `HTTP 401` | The host's Zoom authorisation is dead | Disconnect the host in Settings → Video conferencing, then Connect again |
| Zoom says "Invalid access token" | The authorisation is dead (recreated app, rotated secret, changed scopes) | Disconnect the host, then Connect again |
| Numbers differ between campaign and Statistics | Different windows/denominators | See *What the words mean* above |

Server-side failures (deploy, Redis, worker restarts) are covered in [`DEPLOYMENT.md`](DEPLOYMENT.md) §6 and
[`runbook.md`](runbook.md).

## Where this lives in the code

| Area | File |
|---|---|
| Campaign schema, allocation, pace planner | `app/src/domain/campaign.ts` |
| Zoom ID normalisation and call recovery | `app/src/video/zoomId.ts`, `app/src/video/zoom.ts` |
| Attendance segments and call-report payloads | `app/src/domain/attendanceSegments.ts`, `attendanceRoster.ts` |
| Status machine, start/stop validation | `app/src/domain/campaignLifecycle.ts` |
| Freeze, send, redistribution, end | `app/src/domain/campaignDispatch.ts` |
| Who gets invited (dedupe) | `app/src/domain/audience.ts` |
| Mailbox readiness and batch arbitration | `app/src/domain/campaignSchedule.ts` |
| Campaign funnel | `app/src/domain/campaignStats.ts`, `campaignStatsCollect.ts` |
| Campaign CRM merge, notes, history, CSV | `app/src/domain/campaignCrm.ts`, `campaignCrmCollect.ts`, `campaignCrmExport.ts`, `campaignNotes*.ts`, `rsvpHistory*.ts` |
| Cross-campaign rollup | `app/src/domain/statsOverview.ts`, `statsCollect.ts` |
| Statistics export tables | `app/src/domain/statsExport.ts`, `statsExportCollect.ts` |
| HTTP routes | `app/src/api/routes/campaigns.ts`, `invites.ts`, `sessions.ts`, `stats.ts` |
| Panel views and card actions | `app/public/app.js` (`campaignActions`, `renderCampaigns`, `crmHtml`) |
| Design notes for all of the above | [`architecture.md`](architecture.md) — *Senders & campaigns*, *Scheduling and ending*, *Audience*, *Campaign CRM* |

The short version for reading code: **a campaign is the only object that owns per-recipient state.** Lists,
mailboxes, video calls and reply automations are shared and outlive any single campaign.
