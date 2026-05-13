# Demo Capture Protocol

Operator runbook for capturing demo-video artifacts from real RHODES
incidents. Written for future Pranav at 11pm doing another save.

The premise: every customer-grade demo so far (Jellyfin Save, the
upcoming Esxi Save) is built from artifacts captured during an actual
recovery. This document is the checklist that makes the difference
between "I have the story" and "I have the inputs HyperFrames needs
to render it."

## 0. Before you do anything

If the incident is already firing and you didn't pre-stage, capture
what you can — incident JSON and SSE event log are the load-bearing
artifacts and they're easy to grab after the fact. Terminal
recordings are the hard one to retrofit.

## 1. Pre-stage

You want three windows visible:

1. **Terminal — recording.** Start `asciinema rec` BEFORE the
   incident fires (or before you do whatever will trigger it):

   ```bash
   asciinema rec -i 2 ~/rhodes-video/_capture/$(date +%Y%m%d-%H%M%S)-terminal.cast
   ```

   The `-i 2` caps idle time at 2s so the playback doesn't drag
   through your gaps. Tile this window to roughly the right two-thirds
   of your screen; you'll be running RHODES queries here.

2. **Browser — dashboard.** Open `dashboard-v2/` at the appropriate
   URL (usually `http://localhost:3000` for local, or your Tailscale
   dashboard URL). Make sure the Active Incidents view is visible.
   Resolution at 1920×1080 native if possible — the composition
   captures will be at that size.

3. **Terminal — events feed (background).** Start the SSE event
   stream in another tab/pane and let it append to disk:

   ```bash
   curl -N http://localhost:3000/api/agent/events \
     | tee ~/rhodes-video/_capture/$(date +%Y%m%d-%H%M%S)-events.jsonl
   ```

   Keep this tab off-screen — you don't need it visible, you need it
   captured.

If you're going to screen-record the dashboard (recommended), start
your screen recorder now too, scoped to the browser window only.
OBS, Loom, or `wf-recorder` on Wayland — whatever's already
configured. 60fps if your hardware can sustain it.

## 2. Trigger / let RHODES trigger

Two flavors:

- **Synthetic.** You're rehearsing a story — force the incident
  yourself. For storage-pause: fill the thin pool with a test
  snapshot until QEMU pauses the VM. For service-down:
  `sudo systemctl stop jellyfin` on the target. Don't fake the
  resulting incident — let the autopilot detect it naturally so the
  capture is the real chain end-to-end.
- **Organic.** Something actually broke. Skip to step 3 and hope
  pre-stage was done.

When the incident card appears in the dashboard, that's t=0 for the
demo. Note the wall-clock time — you'll want it for the storyboard
later.

## 3. Capture (during the incident)

While the incident is firing and the operator (you) is approving the
plan, grab these in parallel. Most of them are curls — easy.

### 3a. Incident JSON

```bash
curl -s http://localhost:3000/api/incidents \
  | jq '.[] | select(.status == "active")' \
  > ~/rhodes-video/_capture/$(date +%Y%m%d-%H%M%S)-incidents.json
```

Save this immediately when the card appears. Don't wait — the incident
state mutates as the plan executes.

### 3b. Plan JSON

```bash
curl -s http://localhost:3000/api/agent/pending-approvals \
  > ~/rhodes-video/_capture/$(date +%Y%m%d-%H%M%S)-plan.json
```

Grab this BEFORE clicking Approve. Once you approve, the plan
transitions out of pending and the endpoint will return empty (or the
next pending plan, which isn't what you want).

### 3c. SSE event log

Already streaming to disk from step 1. Once the incident resolves,
stop the stream (Ctrl-C in that tab). The resulting JSONL is your
ground-truth source for the event-log scene in the composition.

### 3d. Dashboard screen recording

If you started screen recording in step 1, it's running. After
resolve, stop it. Save it next to the other artifacts. Save the raw
MOV/MKV — don't pre-trim. Trimming happens in composition.

### 3e. Terminal recording

After the incident resolves, Ctrl-D out of `asciinema rec`. The
`.cast` file is now closed. Save it. Optional: render a preview with
`asciinema play <file>` to sanity-check it.

## 4. Save artifacts under `rhodes-video/<name>/source/`

After capture, move everything from `~/rhodes-video/_capture/` to the
composition's source directory:

```bash
mkdir -p ~/rhodes-video/RHODES\ Esxi\ Save/source
mv ~/rhodes-video/_capture/* ~/rhodes-video/RHODES\ Esxi\ Save/source/
```

Required tree:

```
RHODES Esxi Save/
├── design.md
├── index.html              # HyperFrames composition (TBD)
├── meta.json               # HyperFrames metadata
└── source/
    ├── <ts>-incidents.json
    ├── <ts>-plan.json
    ├── <ts>-events.jsonl
    ├── <ts>-terminal.cast
    ├── <ts>-dashboard.mp4  # full screen recording
    └── <ts>-screenshots/   # any framed PNGs you grabbed
        ├── incident-card.png
        ├── plan-card.png
        └── resolved.png
```

If you skipped any artifact (it happens), note it in the design.md's
"Open production questions" section so the composition author knows
what's missing and can decide whether to re-stage or substitute.

## 5. Hand off to HyperFrames composition

The composition author (likely also you, later) reads:

- `design.md` for the storyboard
- the `source/` artifacts as ground truth for what to render in each
  scene
- the brand bible at `/home/pranav/rhodes-brand/BRAND_BIBLE.md` for
  palette / typography / motion

From there, the HyperFrames workflow takes over (`/hyperframes` skill,
`npm run check`, `npm run render`). That's a separate runbook —
this document ends at the artifact hand-off.

## Quick reference — endpoints you will curl

| Endpoint | What it returns | When to grab it |
|---|---|---|
| `GET /api/incidents` | All known incidents | At t=0 (incident appears) and at t=resolve |
| `GET /api/agent/pending-approvals` | Plan cards awaiting operator | Before clicking Approve |
| `GET /api/agent/events` (SSE) | Live event stream | Stream throughout, save to JSONL |
| `GET /api/playbooks` | Registered playbook list | Once, when scripting voiceover that names the playbook |
| `GET /api/ssh/targets` | Configured SSH targets | If the demo mentions per-target governance |

Endpoint URLs above assume `localhost:3000` — substitute your actual
dashboard URL.

## Common failure modes

- **Forgot `asciinema rec`.** Your terminal scenes will have to be
  re-staged in post (asciinema record into a synthetic transcript
  matching the real one). Annoying but recoverable.
- **Plan JSON missed.** If you approved before grabbing the plan,
  search the SSE event log for `PlanGenerated` / `PlanApproved` —
  the plan payload is on those events.
- **Screen recording at wrong resolution.** Re-record from the
  asciinema + curl artifacts; the dashboard is deterministic from
  the same plan + events.
- **SSE stream dropped mid-incident.** Reconnect. Each event carries
  a timestamp; concatenating two streams and de-duping by
  `(timestamp, type, data.id)` recovers the full record.
