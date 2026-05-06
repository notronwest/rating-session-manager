# Manifesto — Why this exists

This document is written into every repository in this stack
(`rating-session-manager`, `courtreserve-scheduler`, `wmpc_rating_hub`,
`tournament-manager`). It is the *why*. The README in each repo answers
the *what*. If those two ever drift, the README is wrong, not this.

---

## The problem we keep watching people live with

Open Play sessions at every club have the same complaint: the players
in the session aren't all at the level the session was designed for.
A 4.0 session with a 3.5 in it produces lopsided games. The 3.5 has a
miserable hour. The 4.0s feel like they're babysitting. Everyone's
diminished.

What makes it harder: **players who play up are often not aware they're
playing up.** They walk off the court saying "that was a lot of fun!"
or "wow, that was challenging!" — descriptions that are accurate to
*their* experience and unrelated to the experience of the three other
people on the court who were holding back. Self-rating is not just
fallible; it is structurally biased toward generosity.

Level Play — sessions gated to a specific skill range — is the
straightforward answer. Level Play only works if the rating is right.
**This work exists because rating is currently *not* right.**

## Why current rating systems fall short

### Human Vision Based Rating is biased

A human watching a game and assigning a number is doing pattern
recognition against their own internal idea of what a 3.5 forehand or
a 4.0 third-shot drop looks like. Two raters disagree on the same
player. One rater drifts month over month. Local norms creep in: a
"4.0" in one club is a "3.5" in another, twenty miles away. We have
not seen anyone do this *consistently* well. We don't think it's
possible to do it consistently well.

### DUPR is the standard, and the standard is flawed

DUPR is the de-facto rating system in pickleball today, but its
algorithm is heavily weighted on **the score of the match and the
average rating of the players involved**. The published consequences
of that design are well-known and well-complained-about: players have
won 5.0 tournaments without losing a game and watched their DUPR drop,
because the algorithm "expected" them to win by a wider margin against
those opponents.

Score-and-opponent-weighted rating systems measure *outcomes*. They do
not measure *play*. A player who plays a 4.5 game and grinds out a
narrow loss to a 5.0 looks the same to DUPR as a player who shanks
every shot and got carried by a partner. They have the same score.
They are not the same player. Any system that conflates them is going
to mis-rate players, and the people most often mis-rated are the ones
who matter most: the ones near a session boundary.

### What "right" would look like

A rating system that **looks at how you actually play**. Not just
whether your team won the point. The mechanics of the shot, where on
the court you took it, what shot you chose, what the situation was,
how you moved, what you did when you weren't hitting the ball. Pull
that signal out of every game, every rally, every shot — and aggregate
across enough volume that one bad day or one carrying partner can't
swing the rating.

The only realistic way to do this at scale is computer vision — feed
recorded games into a model that extracts the same observations a
trained coach would, but without the rater drift, the local-norm
creep, or the bias.

## Why PB Vision

We've worked with several vision-based rating companies. **PB Vision
is the best of them by a wide margin.** Two reasons:

1. **Data depth.** Their compact insights JSON exposes every shot, every
   rally, every player position. Their augmented insights add 119
   advanced stats. Their avatars are addressable by URL. We can build
   *on* their platform — it's not a black box that returns a number.
2. **Commitment to improving the rating.** They are actively working
   on the vision-based rating problem itself. Every shipped session
   we send them is data that improves the system for everyone.

PB Vision is the AWS-level data layer for pickleball rating. We are
betting on them. We are betting on them so much that we are willing
to build the rest of the pipeline they don't.

## Why this stack — and how the repos fit together

A coach should be able to schedule a Level Play session in their
existing scheduling tool, walk away, and come back with rated games
in the rating system, all without touching a line of code or paying
attention to the plumbing. That requires three things tied together:

### `courtreserve-scheduler`

CourtReserve is the de-facto reservation system at most clubs we've
worked with. It already holds the schedule, the player roster, the
booking metadata, the recurring-session structure. We don't replace
it; we read from it. This repo is the bridge from "what's on the
court today" to "what should the AI process tonight".

### `rating-session-manager`

The orchestration layer. It pulls today's rating sessions from
CourtReserve, accepts the long recording, breaks it into per-game
clips (the open problem — see [docs/game-detection.md](docs/game-detection.md)),
uploads the clips to PB Vision, drives the player-tagging UI, and
hands the resulting insights to the rating hub. It is the thing a
coach interacts with — but most of the time, it just runs.

### `wmpc_rating_hub`

The system of record. Imports PB Vision insights, persists games and
players and shots, exposes the rating itself, drives the coach analysis
and player-facing leaderboard. This is what people see when they ask
"what's my rating?". Everything upstream exists to keep this clean and
honest.

### `tournament-manager`

The downstream consumer. A rating that nobody acts on is a number on a
spreadsheet. Tournaments are where rating *matters* — brackets are
seeded by it, divisions are gated by it, the experience of the entire
event hinges on it. `tournament-manager` is the platform organisers
use to run those tournaments, and it pulls from the same rating pool
the rest of this stack feeds. If `wmpc_rating_hub` is the system of
record, this is the system of consequence.

## What we are committed to

These are not nice-to-haves. They are the principles that distinguish
this project from a system that just outputs another flawed number.

1. **Data-centric, not score-centric.** A rating reflects how you play,
   not whether your partner carried you to 11–9.
2. **Automation by default, with human verification where it matters.**
   Splitting a recording into per-game clips is mostly automatic; a
   coach reviews and confirms before credits get burned. Tagging players
   to PB Vision avatars is a human pick (it has to be — privacy and
   identity), but the rest of the flow is hands-off.
3. **Pay-attention-when-it-fails alerting.** The pipeline runs unattended
   most of the time; failures route to Discord with the actionable
   recovery step. The coach finds out about CR auth expiry, PB Vision
   credit exhaustion, or a crashed detection step the moment it happens,
   not the morning after.
4. **Don't reinvent what others have done well.** PB Vision's vision
   model. CourtReserve's scheduling. Supabase for the data layer. We
   build the integration glue, not the platforms.
5. **Build for other clubs, not just our own.** WMPC is the testbed.
   The architecture is meant to drop into any club running CR + a
   camera + PB Vision.
6. **Rating *is* the product.** Every other piece of the pipeline —
   schedules, recordings, clips, tagging — is in service of producing
   a rating that survives scrutiny. If the rating doesn't survive
   scrutiny, none of the rest matters.

## Where this is going

The end-to-end vision: a coach books a Level Play session in
CourtReserve. The recording uploads. The pipeline splits, tags,
processes, and returns a rated outcome — including per-shot mechanics,
per-rally context, and an updated rating that reflects *how the
players actually played*. The next time someone signs up for a 4.0
session, the system can say with confidence whether they belong.

We are building toward a place where Level Play is the norm, not the
aspiration, and where the rating that gates it is something every
player can trust — because it watched the games.
