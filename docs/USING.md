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
| **Who attended** (video calls) | A real event — usually a Zoom meeting — and its attendance report | Turns "they said yes" into "they showed up" |
| **Campaigns** | A durable job that binds a list + event + mailboxes (+ optional video call) | Sends a large audience over several days, paced, with per-person state |
| **Invitations** | A one-off send, right now | Small or urgent sends that do not need a job |

The flow is always the same shape:

```
Google accounts (who sends) + Contact list (who receives) + Event details
        └──► Campaign (or a one-off Invitation)
                 └──► calendar invites go out, paced per mailbox
                          └──► replies are mirrored to GoHighLevel
                                   └──► attendance is pulled from Zoom
                                            └──► Statistics rolls it all up
```

## The other tabs

- **Documents** — brand and product notes the AI reads when it sorts a list or drafts an invitation. Better
  documents make better groups and better copy.
- **Assistant** (owner/admin) — reviews recent activity and proposes changes you can apply.
- **People** (owner/admin) — team accounts and roles. Members can browse the product; campaign actions are
  owner/admin.
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
| max per day | Hard ceiling for that mailbox per day, across **all** campaigns and one-off invites |
| max per hour | Hourly ceiling, same sharing rule |
| pause between batches | Minimum gap between send batches, so traffic is never back-to-back |
| warm up slowly | Starts at a lower daily cap and raises it day by day up to max per day |
| sending hours | Weekdays + hours + timezone in which **campaigns** may send |

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

### Video calls

**Who attended → + New video call** creates the event record: title, optional join link (Zoom is looked up
if you leave it blank), start/end, the Google account it belongs to, an optional Zoom host, and an optional
link back to an invitation.

Attendance syncs on its own after the call, and **Sync now** forces a refresh. **Details** shows who
attended and who did not, and **Send to GHL** pushes those results to your CRM.

A call linked to a campaign inherits that campaign's **frozen recipients** as its invited list, so
attendance matches the people who were actually emailed. A standalone call has no invited list: the people
who joined appear under **“Attended — not on the invited list”**, and no-show counts stay empty until the
call is linked to a campaign or an invitation.

If Zoom has no report yet — normal for a while after a webinar ends — the call stays **Pending** and the
panel retries hourly for up to 24 hours. Nothing is stored as “0 attended” in the meantime.

If it stays pending, open **Details → What the last sync tried**: each attempt shows the call type, the
Zoom host that asked, the HTTP status of the report and of the past-call fallback, and Zoom's own message.
**Edit call** corrects the type, ID or host without deleting the call, and saving re-syncs immediately. The
panel also retries the other call type and the other connected hosts on its own when the first answer is a
404.

### Sending attendance to GHL and your own endpoint

**Google accounts → ⋯ → Attendance automations** controls delivery for that account:

- **Contact tags** — one per segment: attended, partial, no-show, not invited. A blank partial tag falls
  back to the attended tag, so existing workflows do not change.
- **Segment custom field** — optional GHL field ID that receives `attended` / `partial` / `no_show` /
  `not_invited`.
- **Rules** — per-person webhook rules. Conditions can now target `segment`, `invited` and
  `invitedSource`, alongside minutes watched and session fields.
- **Roster webhook** — optional URL that receives each whole segment, or one snapshot containing all
  segments. Every request carries a `revision`; an unchanged result is not resent. Add an optional bearer
  token if your endpoint expects one — it is stored encrypted, and leaving the field blank keeps the
  current token.

The four segments are:

| Segment | Meaning |
|---|---|
| attended | Invited and watched at least the minimum minutes |
| partial | Invited and watched less than the minimum |
| no_show | Invited but never joined |
| not_invited | Joined but not on the invited list (walk-ins) |

The invited list is cross-referenced automatically: a campaign-linked call uses the campaign's sent
recipients, a one-off invitation uses the attendee list of the calendar event it created, and a standalone
call can name a list with **Edit call**. If none is linked, everyone who joined is `not_invited` and no
no-shows are invented.

**Send to GHL** delivers per contact. **Send roster** forces the roster even when it is unchanged. The same
delivery runs automatically after a successful sync; the roster is skipped when its content has not
changed.

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

A one-off send **spends the same mailbox budget** a campaign would: the daily/hourly counters are keyed by
mailbox, not by feature.

## Sending a one-off invitation

1. **Invitations** → tick the Google accounts that should send. Each shows what it can still send today.
2. Fill in the event: title, description (or **Draft with AI**), start, end, timezone, location/link.
3. Pick the contact list and, if you want, specific groups. The preview shows exactly who will receive it.
4. If anyone on that list was already invited, a **“Also invite people who were already invited”** checkbox
   appears with a count and the previous event they were invited to. Leave it off unless you mean it.
5. **Send in batches** (optional): tick it, set **Recipients per event** (default 300) and **Wait between
   rounds** (hours). The first round goes out immediately; the worker sends the later rounds.
6. **Preview**, then **Send invitations**.

The result tells you what went out and what could not be placed today. Nothing is recalled once sent.
Events are chunked per account, so a guest normally receives a single, unnumbered invitation.

### Sending a one-off in rounds

A round is **one event per selected account**. With three accounts and 300 recipients, a round invites up to
900 people; the panel then waits the delay and sends the next round. The history shows the schedule with
**Pause**, **Resume** and **Cancel**, plus the next round time and how many people are still waiting.

- The 300 is a ceiling **on top of** the mailbox cap. An account with 100 left sends 100 this round and the
  rest waits, so rounds take longer than the caps alone would.
- Rounds stop at the event start. Anyone left at that point is reported as not invited.
- The invited set is re-checked every round, so someone invited elsewhere in the meantime is skipped.
- A failed event's recipients stay queued for the next round.
- Batching off (the default) keeps the original single-send behaviour exactly.

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
| How to split it | **Split evenly**, or **Use my shares** to follow each mailbox's weight |
| Timezone for the calendar invite | The timezone guests will see |
| Which groups to include | Empty means the whole list |
| Also invite people who were already invited | Off by default; see the rules below |
| Start sending | **As soon as I press Begin sending**, or **At a specific time** |
| Stop sending by (optional) | A hard deadline; presets add +1 day / +3 days / +1 week |
| Send in batches | Optional: one event per account per round, then wait |
| Recipients per event / wait between rounds | Appear when batching is on; defaults 300 and 24 h |
| Who this will reach | Live count, already minus anyone invited before |
| When it will finish | Live estimate from the selected mailboxes and their caps |
| Email subject / Description | What the invitation says |
| Event starts / Event ends | The actual event, not the send window |
| Which Google accounts send this | One or more mailboxes; each shows its share |

**Who this will reach** and **When it will finish** are computed with the same code the send uses, so the
numbers you approve are the numbers that get frozen. If the estimate lands after your deadline, add a
mailbox, raise a cap, or move the deadline — before starting.

If **Send in batches** is on, the estimate also shows roughly how many rounds there will be and when the last
one starts. It assumes every account can send its full per-round amount, so a lower cap makes the real finish
later — the note says so.

**Create campaign** saves it as a draft — or as **Scheduled** when you chose a later start. Nothing is frozen
yet either way, and every field can still be changed.

### 2. Start it — the freeze

**Begin sending** (on the card, or automatically at a scheduled time) does four things:

1. Freezes the audience from the list's sorted result, minus anyone already invited for that list.
2. Splits the people across the selected mailboxes by share/quota, interleaving them so each mailbox's
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
- **Send a batch** runs one manual pass for that campaign (up to 200 per mailbox, or the campaign's per-round
  limit when batching is on). It skips the "pause between batches" delay, but the caps, sending hours and
  cooldowns still apply. While a batched campaign is between rounds, it refuses and tells you when the next
  round opens.
- **End sending** asks for confirmation and tells you how many people will never be invited. It is **not a
  recall**: invitations already delivered stay in people's calendars.
- **Delete** removes the campaign and its per-recipient history. Use **End** if you only want it to stop.

## How the sending pace actually works

You set the ceiling; the scheduler decides the moment-to-moment order.

- **Caps belong to the mailbox.** Every campaign and one-off invite using that mailbox shares the same daily
  and hourly counter. Two concurrent campaigns split one budget; they do not double it.
- **A campaign's share only splits it internally** — the "split evenly / use my shares" setting decides who
  in *this* campaign sends which slice, not what the mailbox sends overall.
- **Sending hours** (on the sending account) gate campaigns. Outside them, nothing is sent, and the work
  simply waits for the window.
- **Batch delays** keep sends from being back-to-back. **Warm-up** raises a new mailbox's daily cap gradually.
- **Batched rounds add a second ceiling.** A batched one-off or campaign sends at most the per-event limit
  from each account, then waits. Daily/hourly caps still apply, so a 100/day cap with a 300 batch sends 100
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
11. **A round is one event per account, not one event overall.** Three accounts create three events per round,
    each with its own event ID; attendance reads all of them.

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

### What the words mean

| Word | Means |
|---|---|
| Invitations | Recipient rows actually sent in the period — the same person in two campaigns counts twice |
| Accepted / Declined / Maybe | The RSVP on the calendar invitation |
| No reply | Invited, but no answer recorded |
| Attendance | Sent recipients Zoom reported as attending |
| No-show | Said yes or maybe, but Zoom did not report them as attending |
| Acceptance rate | `accepted ÷ sent` |
| Campaign attendance rate | `attended ÷ (accepted + maybe)` — of the people who said they would come |
| Statistics attendance rate | `attended ÷ (attended + no-show)` — of the outcomes Zoom actually reported |

Numbers can differ between a campaign and Statistics without either being wrong: different windows,
different denominators, and a person can appear in more than one campaign.

Open and bounce rates are deliberately absent — the CRM reminder layer that would measure them does not
exist yet. RSVP answers are the only reply signal.

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
| Attendance sections are empty | Zoom reports not readable, or the call has not happened | **Who attended → Sync now**; if it stays empty, Settings → Video conferencing → **Check access** |
| Synced, but 0 attended while Details lists people under “not on the invited list” | The call has no invited list linked | Link it to the campaign or invitation that sent the invitations, then Sync now. Campaign-linked calls pick this up automatically |
| “Zoom has no report for this call yet”, or the call stays Pending with `HTTP 404` | Zoom has no past call under that ID, type or host | Press **Edit call**, set the right **Type of call**, paste the numeric ID or join link, pick the hosting Zoom account, then save. The panel also tries the other type and other hosts automatically |
| Call stays Pending and details show `HTTP 401` | The host's Zoom authorisation is dead | Disconnect the host in Settings → Video conferencing, then Connect again |
| Zoom says "Invalid access token" | The authorisation is dead (recreated app, rotated secret, changed scopes) | Disconnect the host, then Connect again |
| Numbers differ between campaign and Statistics | Different windows/denominators | See *What the words mean* above |

Server-side failures (deploy, Redis, worker restarts) are covered in [`DEPLOYMENT.md`](DEPLOYMENT.md) §6 and
[`runbook.md`](runbook.md).

## Where this lives in the code

| Area | File |
|---|---|
| Campaign schema, allocation, pace planner | `app/src/domain/campaign.ts` |
| Zoom ID normalisation and call recovery | `app/src/video/zoomId.ts`, `app/src/video/zoom.ts` |
| Attendance segments and roster payloads | `app/src/domain/attendanceSegments.ts`, `attendanceRoster.ts` |
| Status machine, start/stop validation | `app/src/domain/campaignLifecycle.ts` |
| Freeze, send, redistribution, end | `app/src/domain/campaignDispatch.ts` |
| Who gets invited (dedupe) | `app/src/domain/audience.ts` |
| Mailbox readiness and batch arbitration | `app/src/domain/campaignSchedule.ts` |
| Campaign funnel | `app/src/domain/campaignStats.ts`, `campaignStatsCollect.ts` |
| Cross-campaign rollup | `app/src/domain/statsOverview.ts`, `statsCollect.ts` |
| HTTP routes | `app/src/api/routes/campaigns.ts`, `invites.ts`, `sessions.ts`, `stats.ts` |
| Panel views and card actions | `app/public/app.js` (`campaignActions`, `renderCampaigns`) |
| Design notes for all of the above | [`architecture.md`](architecture.md) — *Senders & campaigns*, *Scheduling and ending*, *Audience* |

The short version for reading code: **a campaign is the only object that owns per-recipient state.** Lists,
mailboxes, video calls and reply automations are shared and outlive any single campaign.
