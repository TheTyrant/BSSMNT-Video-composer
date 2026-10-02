# Brief — v2.1 "Final Changes" (received 2026-10-02)

This is the spec for v2.1, kept word for word as received. The build plan is in [roadmap.md › v2.1](roadmap.md#v21--creator-essentials--now). How each point maps onto the code is in [codemap.md §4.0](codemap.md#40-v21--creator-essentials-). Interpretations and open questions are in [decisions.md §J](decisions.md#j-v21--the-three-final-changes-proposed-2026-10-02).

**Product direction (from Omar, same day):** *"Blender growth model with Canva level complexity. We're building a tool to streamline video production process for DJ's, Social media content creators and video hobbyists."*

---

# BSSMNT — Final Changes

Make **only these three changes** to the existing BSSMNT project.

Do not redesign the application, replace existing systems, restructure the current automation, or add unrelated functionality.

---

# 1. PER-CLIP TIMING + IMPORTANCE

Add timing controls to each individual **regular video/image clip**.

## Per-Clip Timing

The per-clip timing system is **not a second timeline**.

It is a local repetition/reference of the existing **master timeline timing system**, associated with each individual clip.

The master timeline remains the source of truth.

Each regular clip should be able to specify how it responds to the master musical timing.

Timing options should include the existing timing divisions used by BSSMNT, including:

* Beat
* Bar
* Measure
* 4/4
* 4/2
* etc.

The purpose is to tell the automation:

> When this clip is used, respond to the master timeline according to this timing value.

For example:

* Clip A → Beat
* Clip B → Bar
* Clip C → Measure
* Clip D → 4/4

All of these remain synchronized to the **same master timeline**.

### Important

Do **not** create an independent timeline for individual clips.

Do **not** make per-clip timing a replacement for the master timeline.

It simply tells the automation how that particular clip should respond to the master musical timing.

## Importance

Add an **Importance** value to each regular video/image clip:

* 1
* 2
* 3
* etc.

Importance is a weighting value for the existing automation system.

It can influence how automation selects, repeats, progresses through, or weights clips in relation to their timing.

Importance is **not**:

* a story position
* a quality rating
* a narrative importance score
* a manual editing priority

It is simply additional weighting information available to the automation.

## Story Assets Are Excluded

**Hook, Result/Climax, and CTA assets do not use Per-Clip Timing or Importance.**

Those assets have fixed structural positions and appear **once**.

## Voice Is Excluded

**Per-clip timing must have no effect on Voice Over recording, playback, duration, or placement.**

Voice is an independent audio layer.

Changing the timing behavior of a video/image clip must not alter or interfere with the voice track.

---

# 2. STORY MODE

Add an optional **Story Mode**.

Free Mode remains the normal unrestricted BSSMNT workflow.

Story Mode is activated through a button/toggle.

## Free Mode

When Story Mode is OFF:

* Existing BSSMNT automation remains unrestricted.
* No narrative positions are required.
* Existing clip behavior remains unchanged.

## Story Mode

When Story Mode is ON, allow the user to designate three optional structural positions:

* **Hook**
* **Result / Climax**
* **CTA**

These function as structural anchors for the generated sequence.

## Asset Assignment

Allow the user to assign a Story Position directly to an asset/clip.

Story Position options:

* None
* Hook
* Result / Climax
* CTA

## Automatic Placement

Story blocks are placed automatically.

If all three are assigned:

**HOOK → AUTOMATED CONTENT → RESULT / CLIMAX → CTA**

If there is no Result/Climax:

**HOOK → AUTOMATED CONTENT → CTA**

If there is no Hook:

**AUTOMATED CONTENT → RESULT / CLIMAX → CTA**

If there is no CTA:

**HOOK → AUTOMATED CONTENT → RESULT / CLIMAX**

The user does not need a second timeline to manually position these blocks.

## Static, Single-Use Behavior

Hook, Result/Climax, and CTA are **static structural positions**.

Each designated story asset appears **once**.

They do not participate in the regular clip timing/Importance system.

There is no need for:

* timing weighting
* Importance
* repetition weighting
* frequency selection
* automated reselection

Their Story Position determines where they go.

Therefore:

**Hook = beginning, once**

**Result/Climax = after automated content, once**

**CTA = ending, once**

The existing automation fills the content between the structural anchors.

---

## Story Mode Music Fading

Add an optional **Auto Fade Music to Story Blocks** setting in Story Mode.

When enabled, BSSMNT should automatically adjust the music around the Story Mode structural blocks:

* Hook
* Result / Climax
* CTA

The purpose is to allow the music to **fade in and/or fade out around the story blocks** so the user can create intentional transitions between the music and the narrative moments.

The user should be able to enable or disable this behavior.

### Conceptual behavior

The story blocks act as musical transition points.

For example:

**Music → fade → HOOK → music resumes/fades in → automated content → music → fade → RESULT/CLIMAX → music resumes/fades in → CTA**

The exact fade implementation should use the existing audio architecture rather than introducing a separate audio system.

The important requirement is that Story Mode can optionally make the music respond to the placement of the story blocks.

---

# 3. VOICE RECORDING / IMPORT

Add Voice Over functionality to the existing BSSMNT workflow.

There should be two ways to provide voice:

## Record Voice

Allow the user to record a voice track directly inside BSSMNT.

Basic workflow:

1. Select Voice Recording.
2. Record narration/voice.
3. Stop recording.
4. Add the resulting recording as a voice track.

## Import Voice

Allow the user to import an existing voice recording/audio file.

The imported recording becomes a voice track in the project.

## Voice Controls

Voice must have its own:

* **Volume control**
* **Normalization function**

Normalization should operate on the voice track independently from the music.

Volume should allow the user to adjust the voice level independently.

## Music + Voice

Voice should remain a **separate audio layer from the music**.

The basic workflow should support:

**Music + Voice**

The user should also be able to mute/remove the music when they want a voice-only result.

## Critical Separation From Clip Timing

Per-clip timing applies to the automated video/image clips.

It must **not** control, modify, retime, cut, repeat, or otherwise affect the Voice Over track.

Voice remains independent of the clip timing system.

---

# IMPLEMENTATION BOUNDARY

These are the **only three requested changes**:

### 1. Per-Clip Timing + Importance

Regular video/image clips only.

### 2. Story Mode

Hook, Result/Climax, and CTA are static, single-use structural anchors, with optional automatic music fading around those story blocks.

### 3. Voice Recording / Import

Record or import voice, with independent volume and normalization.

Preserve the existing BSSMNT architecture and automation wherever possible. Do not introduce unrelated features or redesign existing functionality.
