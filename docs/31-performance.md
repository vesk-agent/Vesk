# Performance profiles

A busy Pulse board can receive dozens of messages a second. The performance profile decides how often the panel redraws them, how many rows it keeps, how fast clocks tick and whether things animate, so the panel stays smooth on any machine. It never changes what your agent does or how fast a trade is sent.

## In the panel

**Setup → Performance** shows the profile you're on as a speed gauge, and live numbers from this browser tab, refreshed once a second:

- frames per second;
- Pulse updates per second;
- the render interval and the websocket batch interval;
- rows mounted on screen;
- JS memory (only Chromium-based browsers report it);
- **Display**: your screen's refresh rate, the same number the status bar shows next to service health.

Pick **Low resource**, **Auto** or **Full speed** on the three cards. Auto says which pace it picked and why. The same choice is in Settings → **Performance**.

Messages always reach the board as they arrive; the profile only decides how often you see them. Rows are virtualized: only the rows on screen, plus a few above and below, are mounted, so a column with 300+ coins renders about 13 rows.

## Settings

| Profile | Render | Websocket batch | Rows kept | Rows mounted beyond the screen | Clock | Animation |
|---|---|---|---|---|---|---|
| Low resource | at most every 1 s | 2 s | 150 | 2 | 5 s | off |
| Auto (default) | every 250 ms; every 1 s above ~40 messages/s | 1 s | 400 | 6 | 1 s | on |
| Full speed | every message (next frame) | 0.5 s | 1,000 | 12 | 0.5 s | on |

**Animation off** (Low resource) turns off:

- page transitions and the sliding tab and sidebar indicators;
- number flashes and new-row slides;
- the Ultra quick-buy glow (your choice is kept and comes back in Auto or Full speed);
- the art beside focus pages (Claim, Holder access, Launch) and the faint dot texture behind the panel.

Your system's *reduce motion* setting turns off the same motion, whatever the profile.

## Limits and what's approximate

- The live numbers are this browser tab's, not your agent's. Your agent's speed is in its logs and `vesk doctor`.
- Auto switches pace from the message rate over the last few seconds, so it can lag a sudden burst by a moment.
- Memory shows "–" in browsers that don't report it (Firefox, Safari).
- Full speed on a slow machine can drop frames; if the frames-per-second number falls, use Auto.
- **The refresh rate is measured, not read.** Browsers don't report it, so the panel times 60 frames (the median interval), every 5 s (every 20 s in Low resource) and again when the window moves to another screen, and pauses while the tab is hidden. Near a common rate (60, 75, 90, 120, 144, 165, 240, 360, 480) it shows that, e.g. *240 Hz*; otherwise the raw *N fps*, which means something is slowing the page.
