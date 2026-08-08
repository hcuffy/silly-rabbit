# What is Silly Rabbit?

Silly Rabbit is an AI agent that tests your web app's UI for you. Point it at your
app, tell it what to check, and it drives a real browser, looks at what
changed, and tells you whether that change is a problem — the same way a
coworker reviewing your pull request would flag something that looks wrong.
Think "CodeRabbit for the UI" instead of for your code diff: it doesn't read
your commits, it looks at what your app actually renders after a change and
judges whether that's expected or a regression.

It's built to be quiet by default. The first time it sees a screen, it just
remembers what that screen looks like — nothing to review yet. On every later
run, it only speaks up when something is actually different from what it
remembers, and it uses judgment (not just "any pixel changed") to decide
whether that difference looks like a real problem or a harmless variation.

## Three ways it tests your app

**Scripted checks.** You give it a short plain-English instruction — "test the
locations flow" — and it navigates through that part of your app the same way
every time, watching for browser errors, failed network requests, blank
screens, and anything about the page's structure or content that's changed
since last time. This is the steady, repeatable baseline check: same path,
every run, flag what's different.

**Exploratory testing.** For this mode, you describe a feature in a sentence
or two — what it's called, roughly what it does — and the agent goes and
finds it in your app on its own. Once there, it looks at what's actually on
the screen (the buttons, the form fields, what kind of data it's showing) and
comes up with its own test ideas: a "happy path" check (does the normal, expected
use of this feature work?) and a "boundary" check (what happens if you try to
break it — an empty required field, a value that shouldn't be allowed, and so
on). It then actually performs those checks in a real browser and judges the
result. If a boundary check involves creating something, the agent cleans up
after itself — it verifies its own test data actually got removed before
calling the check done, and if cleanup fails, it tells you rather than leaving
a mess silently.

**Replay a recording of yourself using the app.** Instead of writing an
instruction or describing a feature, you can just use the app yourself, once
— click around, fill in a form, whatever the flow is — with a recorder
running in the background (a one-off command you run from the terminal,
against a real browser it opens for you). From then on, you can replay that
exact walkthrough any time you want, as often as you like, and it'll flag
anything that's changed since you recorded it — the same before/after
judgment as the other two modes, no charter-writing or feature-description
needed. Replaying is a button in the dashboard like everything else; only the
recording step itself is a terminal command, since that's the part that needs
a real human actually driving the browser. There's a second flavor of replay,
too: instead of hitting your app's real backend again on every replay, it can
instead replay against the exact responses your app gave back the first time
you recorded — useful when you don't want a replay run writing real data
every time it runs. One honest limitation, worth being upfront about: this is
one person's recorded walkthrough, not the aggregate of real traffic from all
your actual users — some tools built specifically around replaying real
production traffic go further than this does, by design; that's a
deliberately different tradeoff, not something this mode is trying to match.

All three modes end up in the same place: a list of findings you can review, with
the AI's reasoning attached to each one.

## It remembers, so it doesn't nag you

The whole point of remembering prior runs is to cut down on noise. Once you've
looked at a finding and told the agent "yes that's a real problem" or "no,
that's intentional," it remembers your answer. On future runs, if that same
situation comes up again, it won't ask you about it a second time — it either
stays quiet (if you said it was fine) or keeps flagging it clearly as a known,
still-unresolved issue (if you said it was a bug). You're only ever asked
about something once, and only interrupted by things that are actually new.

## It won't do anything destructive

Every check runs behind a safety floor that exists specifically so an
autonomous agent clicking around your real app can't cause harm:

- It will only ever navigate within the app you told it to test — never
  wanders off to some other site or domain.
- It refuses to run against anything that looks like a real production
  environment, as a second layer of protection on top of the first.
- It will not click anything that looks like Delete, Pay, Confirm, or
  Purchase — with exactly one narrow, deliberate exception: when the
  exploratory-testing mode creates a throwaway test record to check a
  boundary case, it's allowed to delete only that specific record it just
  created, and only after double-checking it's deleting the right one.
- Every run has hard limits on how many steps it takes, how many times it
  calls the AI, and how much that's allowed to cost in a single run — so a
  run can never spiral into an unexpectedly expensive or runaway session.
- If any of these limits gets tripped, the run stops immediately and says
  why. Nothing ever quietly keeps going after a safety check fails.

## What you see day to day

The dashboard is where you actually use this. From there you can:

- Kick off a new scripted check or a new exploratory test against your app.
- See a history of every run, with a simple status (running, done, failed)
  and roughly when it happened.
- Open any run to see exactly what it found — what the AI's research turned
  up about the feature it tested, what test ideas it came up with, and how
  each one went.
- Look at each individual finding: the AI's plain-English reasoning for why it
  flagged something, how confident it was, and a screenshot of the screen at
  the moment it flagged it.
- For findings where something on the page changed, see a side-by-side view
  of what the screen looked like before versus after — the same kind of
  "here's exactly what changed" view you'd get from a code diff, but for the
  screen's content and structure instead of source code.
- Confirm, dismiss, or mark a finding as intentional with a single keystroke,
  which is exactly what teaches the memory system what to stay quiet about
  next time.
- For exploratory-testing features, ask the agent to write up a plain-English
  summary of what it's learned about that feature so far — what it does, what
  edge cases have already been checked, what's been confirmed as intentional
  versus what's still an open issue. Every time you ask, it keeps the
  previous write-up too, so you can see how its understanding of a feature
  has evolved over time, not just the latest snapshot.
- The dashboard itself is protected by a password, so it isn't something
  anyone stumbling onto its address could open up and start clicking around
  in.

## Coding agents can call it directly too

Everything above assumes you're the one driving — opening the dashboard,
starting a run, reviewing what it found. Silly Rabbit can also be called
directly by a coding agent (Claude Code, Cursor, and similar tools) while
you're in the middle of writing code, without you ever opening the dashboard
yourself. The agent can kick off any of the three testing modes above, or
check on one already running, and read back exactly what it found — the same
findings, the same reasoning, the same safety floor — all from inside your
coding session instead of a separate browser tab. This runs alongside the
dashboard, not instead of it: anything a coding agent triggers shows up in
the same run history you'd see if you'd started it by hand. One honest note:
this way in is local-only, and it doesn't go through the dashboard's password
— it's meant for the same person already sitting at the same machine running
their coding tools, the same level of trust as running a command yourself in
a terminal, not a new door open to anyone else.

## What's solid versus what's still early

The scripted-check mode and the exploratory-testing mode have both been
proven against a real, real-world application, not just internal test setups
— including a full run of the exploratory mode that researched a real
feature, came up with its own test ideas, executed them for real, and cleaned
up after itself correctly.

A few things are still early or not fully proven yet, worth knowing about
honestly rather than glossing over:

- There's an experimental capability for comparing screenshots pixel by pixel
  as a second signal alongside the AI's own judgment, on top of the existing
  before/after screenshot views. The underlying comparison is built and
  tested, but it needs a certain amount of real usage to accumulate before it
  actually has anything to show — so for the moment, don't expect to see it
  producing results yet, even though the feature itself is switched on.
- A couple of narrow assumptions about how your app structures its web
  addresses (things like how it numbers individual records, or how it uses
  search/filter parameters in the URL) haven't been double-checked against a
  real app yet. This doesn't block anything from working — it's just an
  honest note that those specific edge cases are still unconfirmed rather
  than verified.
- This is a young, actively-developed project built by one person, not a
  polished commercial product yet. Expect some rough edges, and expect things
  to keep changing and improving.
