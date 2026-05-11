# vClaw YC Demo — Design System

Cinematic, terminal-forward, premium-OSS aesthetic. The vibe: Linear meets Anthropic meets a serious infra tool. Confident, dense, never childish.

## Palette (extracted from vClaw dashboard-v2)

- bg-primary: `#0B1120` — deep navy, almost-black
- bg-card: `#111928` — slightly raised panels
- bg-elevated: `#162035` — terminals, modals
- bg-active: `#1f2d4a` — focused/active states

- text-primary: `#EEF2F7`
- text-secondary: `#8899B0`
- text-tertiary: `#5A7491`
- text-accent: `#FFFFFF`

- brand: `#FF9500` — vClaw orange (primary accent)
- brand-deep: `#E08200`
- brand-glow: `rgba(255, 149, 0, 0.20)`

- success: `#22c55e`
- warn: `#eab308`
- info: `#3b9eff` — used for "destination cloud" callouts (Proxmox / AWS)
- purple: `#a78bfa` — used sparingly for agent-state cards
- error: `#ef4444`

## Typography

- Display: `Syne` — only for the hero/end-card "vClaw" wordmark and major callout slams
- Sans: `Inter` — all body, headings, UI labels
- Mono: `JetBrains Mono` — terminal blocks, command lines, agent log lines, code-style labels

Numbers use `font-variant-numeric: tabular-nums`.

## Corners

- 8px on cards
- 6px on chips/pills
- 12px on terminal windows / hero cards
- 0px on full-bleed slabs

## Spacing density

Cinematic-dense. Generous padding inside terminals (40-56px), generous gaps between slam-style hero lines (24-40px).

## Depth

Subtle. Soft outer glow on the brand orange when it appears as a status; thin 1px borders at `rgba(255,255,255,0.07)` on cards. No drop shadows on text.

## Motion language

- Entrances: `power3.out` for headlines, `expo.out` for slabs/slams, `power2.out` for body lines, `back.out(1.4)` for icons/chips.
- Stagger: 0.05–0.12s for log lines, 0.15–0.25s for hero stacks.
- No bounce. No spring on text. No anything cute.
- Transitions between scenes: fast crossfade or slide-up wipe — never linger on a black frame.

## Voice

- Direct, unsoftened, slightly cocky.
- Short lines. Each on its own emotional beat.
- The terminal speaks like a real CLI — no emoji, no "hooray you did it" copy.

## What NOT to do

- No retro CRT scanlines.
- No "AI brain" stock visuals (no neural-network meshes, no glowing skulls).
- No rainbow gradients.
- No multiple competing accent colors per scene — pick one.
- No fully-formed text appearing without an entrance tween.
- No exit animations except on the very last scene.
