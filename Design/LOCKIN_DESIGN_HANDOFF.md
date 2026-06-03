# Lockin App Redesign Handoff

This document is the source of truth for redesigning the Lockin iPhone app without seeing any reference image. The target is a calm, premium, native iOS training app with visible strength progress, consistency, scores, and serious endurance-training context. It should feel closer to a beautifully designed athlete notebook than a generic workout dashboard.

The app must not look like an AI-generated fitness poster. Avoid neon, crypto-dashboard styling, overdesigned badges, glowing cards, black-and-blue gamer UI, generic bodybuilder imagery, and loud motivational decoration.

The desired style is: Strava-level clarity, Apple-level restraint, Patagonia-like physicality, and notebook-like calm.

## 1. Product Feeling

Lockin is a serious training system for people who are building difficult physical capacity over time: pull-ups, push-ups, plank, running volume, ultra preparation, consistency, and coach feedback.

The app should communicate discipline without aggression. It should be beautiful enough that the user wants to open it daily, but quiet enough that logging training never feels like admin work.

Core feeling:

- Calm, focused, disciplined.
- Premium but not luxurious.
- Athletic but not gym-bro.
- Manual-first and fast.
- Data-rich but not visually noisy.
- Progression is visible, but not childish.

The most important design principle: the user should understand today's work within three seconds.

## 2. Design Direction Name

Use the internal style name: **Alpine Notebook**.

This means:

- Warm off-white background, not cold white.
- Deep graphite text, not pure black everywhere.
- Forest green as the main progress color.
- Muted olive and stone tones for secondary data.
- Thin borders, soft cards, generous spacing.
- Beautiful typography.
- Small, clear charts.
- Quiet badges and scores.
- Optional monochrome athlete illustrations or mountain imagery, used sparingly.

The app should not feel futuristic. It should feel built, tested, and trusted.

## 3. Non-Negotiable Product Requirements

The redesign must preserve these product ideas:

1. Pull-up, push-up, and plank progress must be visually strong.
2. Consistency must be visible and emotionally rewarding.
3. Strength score, levels, streaks, and XP are allowed, but must be restrained.
4. The Today screen must be the command center.
5. Coach content should feel like a human coach note, not like a glowing AI chatbot.
6. Running and ultra preparation must be present, but not overpower the strength base.
7. The app should remain native iPhone-first and manual-first.
8. The bottom navigation remains: Today, Progress, Coach, Log, Profile.

## 4. Visual Identity

### 4.1 Color Palette

Use this palette as the default. These names should become design tokens in SwiftUI.

```json
{
  "colors": {
    "background": "#FAF8F2",
    "backgroundSecondary": "#F3F0E8",
    "surface": "#FFFFFF",
    "surfaceWarm": "#F7F4EC",
    "surfaceElevated": "#FEFCF7",
    "border": "#E4DED2",
    "borderStrong": "#D4CCBD",
    "textPrimary": "#171A15",
    "textSecondary": "#5F6258",
    "textTertiary": "#8D8A80",
    "forest": "#203A24",
    "forestLight": "#385B38",
    "olive": "#73804A",
    "sage": "#AAB18A",
    "stone": "#C8C1B3",
    "success": "#2E6B3F",
    "warning": "#B7791F",
    "danger": "#A14A3B",
    "blueRunning": "#3D6F91",
    "rankDark": "#111713",
    "rankDarkSecondary": "#1D241F"
  }
}
```

Use forest green for primary progress and core actions. Use olive or sage for secondary progress. Use blue only for running-specific information. Use warning/danger only for pain, missed sessions, elevated fatigue, or real risk states.

Do not use neon green. Do not use purple AI gradients. Do not use electric blue as the main brand color.

### 4.2 Typography

Use native iOS typography. The app should feel SwiftUI-native, not like a web app inside an iPhone.

The current canonical Today reference uses a stronger editorial serif than the earlier handoff. Follow this type system:

- Today date eyebrow: SF Pro Text, 13 pt, semibold, uppercase, letter spacing 1.6, forest.
- Today hero: system serif / New York style, 34 pt, semibold, title case, text primary. Copy is `Locked In.` with the period.
- Screen title: SF Pro Display, 30-34 pt, bold.
- Card section label: SF Pro Text, 12 pt, semibold, uppercase, letter spacing 1.2, forest.
- Workout title inside Today card: system serif / New York style, 18 pt, semibold, text primary.
- Card title elsewhere: SF Pro Text, 15-17 pt, semibold.
- Body text: SF Pro Text, 14-16 pt, regular.
- Metadata / labels: SF Pro Text, 11-13 pt, medium, uppercase only when used as section labels.
- Large numbers: SF Pro Display or system serif depending on context, 26-42 pt, medium or semibold.
- Small numbers: SF Pro Text, 14-17 pt, medium.
- Tab labels: SF Pro Text, 12 pt, medium. Active tab label uses forest and semibold.

Use serif for the Today hero, Today workout title, and selected summary values such as `Iron` when matching the reference. Do not use serif for dense controls, metadata, form fields, or navigation labels.

### 4.3 Spacing

Use generous spacing. The last design direction should breathe.

Recommended layout values:

```json
{
  "spacing": {
    "screenHorizontal": 20,
    "screenTop": 16,
    "sectionGap": 24,
    "cardPadding": 16,
    "cardGap": 12,
    "rowGap": 10,
    "microGap": 6,
    "bottomSafeAreaExtra": 12,
    "tabBarClearance": 96
  },
  "radius": {
    "card": 8,
    "largeCard": 10,
    "button": 6,
    "pill": 999,
    "small": 8
  },
  "borderWidth": {
    "hairline": 0.5,
    "standard": 1
  }
}
```

Use cards, but do not stack too many heavy cards. Surfaces should feel like paper sheets, not floating glass panels.

### 4.4 Shadows

Use almost no shadows. Prefer borders and slight tonal contrast.

Acceptable card treatment:

- Fill: `surface` or `surfaceElevated`
- Border: `border`
- Shadow: optional, very subtle, y: 2, blur: 8, opacity: 0.04

Avoid glassmorphism, blur-heavy panels, strong drop shadows, and glowing edges.

## 5. Global App Structure

The app has five main tabs:

1. Today
2. Progress
3. Coach
4. Log
5. Profile

Bottom tab bar should be native-looking, light, and quiet. It uses a warm solid off-white or white surface with a hairline top border. Active tab uses forest green and may use a filled icon. Inactive tabs use tertiary text. Icons are thin line icons.

Do not use a custom futuristic tab bar. Do not use large colored icon blocks.

## 6. Main Screen Specifications

### 6.1 Today Screen

The Today screen is the most important screen. It should feel like opening a training notebook for the day.

Canonical visual hierarchy:

1. iOS status bar.
2. Date eyebrow: `THURSDAY, MAY 16`, uppercase, forest, positioned above the hero.
3. Circular profile/avatar on the upper right, aligned visually with the hero block. Use a real athlete avatar when available; initials are fallback only.
4. Hero status: `Locked In.` in large serif title case with period.
5. Short line: `Discipline today. Freedom tomorrow.`
6. Primary card: Today’s Work.
7. At a Glance card with streak, strength score, and level.
8. Daily Progress card with pull-ups, push-ups, and plank progress bars.
9. Bottom split card with `Next Run` and `Tomorrow`.

The latest attached Today reference overrides the older wordmark-first Today layout. Do not show a `LOCKIN` wordmark on the canonical Today screen unless a newer reference explicitly restores it.

Example layout:

- Background: warm off-white.
- Horizontal screen padding: 20 pt.
- Vertical gap between Today cards: 12 pt.
- Date: `THURSDAY, MAY 16`.
- Hero: `Locked In.` in large text-primary serif.
- Subtitle: muted grey.
- Avatar: 56 pt circular image, top right.

Primary Today card:

- Section label: “TODAY’S WORK”.
- Main title: “Pull Strength”.
- Prescription: “5 × 5 Pull-ups”.
- Rest: “Rest 2:00”.
- 36 pt circular exercise thumbnail on the left.
- Monochrome pull-up illustration on the right, about 88 × 96 pt on a 393 pt wide iPhone. It must read clearly as a person on the bar without forcing the title to wrap or pushing the metric cards below the first viewport.
- Coach note box: warm grey inset with direct note.
- Primary CTA: “Start Session” with arrow.
- No `Mark missed` button on the primary Today card in the canonical reference. Missed handling may exist in overflow or guided-session controls.

Example copy:

> Last week was strong. Leave one rep in reserve today.

At a Glance card:

- Section label: `AT A GLANCE`.
- Three equal columns.
- Left: flame icon, `12`, `Day Streak`.
- Middle: sparkline icon, `72`, `Strength Score`.
- Right: crest icon, `Iron`, `Current Level`.
- Use subtle vertical dividers between columns.

Daily Progress card:

- Section label: `DAILY PROGRESS`.
- Three rows: Pull-ups, Push-ups, Plank.
- Each row has a small circular exercise thumbnail, label, right-aligned value, right-aligned percentage, and a thin progress bar.
- Example values:
  - Pull-ups: `32 / 50`, `64%`.
  - Push-ups: `68 / 100`, `68%`.
  - Plank: `03:20 / 05:00`, `68%`.

Bottom split card:

- Two columns separated by a vertical divider.
- Left column: `NEXT RUN`, `Easy Run`, `8-10 km`, `Zone 2`.
- Right column: `TOMORROW`, `Mobility`, `10 min`, `Recovery`, chevron on the far right.

Older Also Planned fallback:

- Plank — 3:00 — Core stamina.
- Mobility — 10 min — Recovery.

Use the older Also Planned list only when the new summary cards cannot be populated. Each fallback row has a small completion circle on the right. Completed rows fill with forest green. Planned rows are outlined.

Do not add metrics beyond the canonical Today reference. The Today screen is allowed to show at-a-glance stats and daily progress because they are part of the reference, but avoid additional dashboards or analytics.

### 6.2 Progress Screen

Progress is where strength gamification becomes beautiful. This screen should make the user want to keep improving.

Top:

- Screen title: “Progress”.
- Optional plus or filter icon on the right.
- Segmented control: Strength / Running.

Strength view must include goal cards for:

1. Pull-ups
2. Push-ups
3. Plank

Each goal card includes:

- Exercise name.
- Goal label.
- Current number and target number.
- Percentage progress.
- Thin semi-circular arc.
- Small sparkline trend at the bottom.
- Optional last updated date.

Example card data:

- Pull-ups: 32 / 50, 64%.
- Push-ups: 68 / 100, 68%.
- Plank: 03:20 / 05:00, 67%.

The card should feel like a calm achievement sheet, not a game dashboard. The large number should be the visual hero. The arc and sparkline support it.

Running view should include:

- Target race card.
- Weekly volume.
- Long run distance.
- Time on feet.
- Elevation gain.
- Simple weekly volume bar chart.
- Recent long-run trend.

Do not mix too many running metrics into the strength screen.

### 6.3 Consistency / Score Area

This may live inside Progress or as a drill-in screen. It is important enough to define separately.

Purpose: show the athlete that daily execution compounds.

Required elements:

- Week / Month / Year segmented control.
- Weekly completion row: 7 rounded squares.
- Label: “This Week 5 of 7”.
- Current streak.
- Best streak.
- Strength Score.
- Score sparkline.
- Level card.

Weekly squares:

- Completed: forest fill.
- Planned today: forest outline or light fill.
- Missed: subtle danger outline or warm stone, not aggressive red.
- Rest day: pale stone.

Strength Score:

- Large number, e.g. “72”.
- Small denominator: “/ 100”.
- Trend line below.
- Optional delta: “+6 from last week”.

Level card:

- Level name, e.g. “Iron”.
- XP, e.g. “2,450 XP”.
- Thin progress bar to next level.
- Optional small crest icon.

The level design may use a dark card for contrast, but only one dark card per screen. It should feel like a premium membership card, not a video-game loot card.

### 6.4 Coach Screen

The Coach screen must not look like “AI”. It should look like a coach’s notebook.

Top:

- Title: “Coach”.
- Optional small settings icon.

Primary card:

- Label: “Coach Read”.
- Date: “Today”.
- Short summary in plain language.
- Optional mountain image or plain warm background.
- Link: “View full read →”.

Example copy:

> You’re building real consistency. Pull-ups are trending up. Focus on full ROM and leave one rep in reserve.

Actions:

- Generate Strength Week.
- Generate Running Week.
- Coach Settings.

Each action card:

- Simple icon on the right.
- Title.
- One-line description.
- Chevron.

Model selection can exist, but it should be visually secondary and placed low on the screen. Do not make model settings a major product surface.

Avoid:

- Brain icons as hero visuals.
- Purple glowing gradients.
- “AI magic” language.
- Chatbot visual styling.

Use “Coach” as the user-facing concept, not “AI Coach”, unless technically required in settings.

### 6.5 Log Screen

The Log screen is the training history.

Top:

- Title: “Log”.
- Calendar icon on the right.
- Month selector: “May 2025”.
- Calendar row/grid.

Calendar day states:

- Completed: forest dot or filled small circle.
- Planned: outline circle or blue running dot if run-specific.
- Missed: muted red/brown dot.
- Deload/recovery: stone dot.
- Today: stronger forest circle.

Below calendar:

- Group by date.
- Each workout row contains icon, title, status, and optional checkmark.

Example:

Thursday, May 16

- Pull Strength — Completed.
- Plank — Completed.
- Mobility — Completed.

Wednesday, May 15

- Push Strength — Completed.

The log should be easy to scan, not decorative.

### 6.6 Profile Screen

The Profile screen contains athlete settings and targets.

Top:

- Title: “Profile”.
- Settings gear.
- Athlete card: avatar, name, athlete type.

Sections:

1. Strength Targets
2. Running Profile
3. Equipment
4. Injury & Notes
5. Data & Reset

Strength Targets card:

- Pull-ups: target 50, current 32 / 50.
- Push-ups: target 100, current 68 / 100.
- Plank: target 5:00, current 03:20 / 05:00.
- Small progress bars.
- Edit action.

Running Profile card:

- Target race.
- Race date.
- Weekly volume.
- Long-run distance.
- Easy pace / HR zone.

Equipment:

- Pull-up bar.
- Parallettes.
- Dumbbells.
- Resistance bands.

Use plain line icons and compact labels.

### 6.7 Running Overview Screen

Running should feel integrated but slightly quieter than strength.

Top:

- Title: “Running”.
- Segmented control: Overview / Plan / Workouts.

Race card:

- Race name.
- Race date.
- Days to race.
- Optional mountain image.

Weekly summary:

- Distance.
- Time.
- Elevation.
- Long run.

Chart:

- Weekly volume bars.
- Use olive/forest bars.
- Running-specific blue may be used sparingly.

### 6.8 Run Detail Screen

Run detail is for completed runs.

Header:

- Back button.
- Date.
- More menu.
- Title: “Long Run”.
- Main metric: “28.6 km”.

Metrics:

- Moving time.
- Average pace.
- Elevation gain.
- Average HR.
- Calories.
- HR zone.

Fuel & Hydration:

- Carbs.
- Fluid.
- Sodium.
- GI issues if logged.

Notes:

- Plain text training note.

Keep it clinical and readable.

### 6.9 Level / Achievement Screen

This screen can be darker than the rest of the app, but only if it remains refined.

Use dark forest/graphite background, not pure black neon.

Content:

- Level title, e.g. “Iron”.
- Small crest icon.
- XP number.
- Progress to next level.
- Achievement list.

Achievement rows:

- Consistency King — Train 14 days in a row.
- Early Riser — Log a workout before 8am.
- Unbroken — Complete 50 pull-ups in a day.
- Plank Master — Hold a 5 minute plank.

Completed achievements use forest/sage checkmarks. Incomplete achievements show progress, not failure.

## 7. Component Specifications

### 7.1 App Header

Used on Today and some major screens.

- Today canonical reference: no `LOCKIN` wordmark. Use the date eyebrow, hero title, subtitle, and avatar layout defined in section 6.1.
- Other major screens: left title or wordmark as specified per screen.
- Right: avatar/settings/action.
- Height: 44-56.
- Horizontal padding: 20.

### 7.2 GoalMetricCard

Purpose: show progress toward a measurable target.

Fields:

- title
- goal label
- current value
- target value
- percentage
- sparkline data
- optional unit

Layout:

- Title top left.
- Goal label under title.
- Large current/target value left.
- Arc right.
- Sparkline bottom full width.

Style:

- Background: surface.
- Border: border.
- Radius: 14.
- Padding: 16.

### 7.3 ConsistencyStrip

Purpose: show weekly completion.

Fields:

- days[7]
- status: complete/planned/missed/rest/today
- summary label: “5 of 7”

Style:

- 7 rounded squares, 30-34 px each.
- 8 px gap.
- Completed squares use forest.
- Rest squares use backgroundSecondary.

### 7.4 WorkoutCard

Purpose: show planned or completed workout.

Fields:

- type icon
- title
- prescription
- duration/rest/zone
- status
- priority optional

Style:

- White card with border.
- Simple line icon.
- Completion circle on right.
- No colored full-card backgrounds.

### 7.5 CoachReadCard

Purpose: summarize coach feedback.

Fields:

- label
- date
- short coach summary
- optional image
- link

Style:

- Warm surface.
- Optional monochrome/low-saturation mountain photo at bottom.
- No purple, no glowing AI effects.

### 7.6 RankCard

Purpose: show level and XP.

Fields:

- rank name
- XP
- next rank progress
- crest icon optional

Style:

- One dark premium card allowed.
- Deep graphite/forest background.
- Cream text.
- Thin progress bar.
- Small crest.

### 7.7 Primary Button

- Fill: forest.
- Text: warm white.
- Height: 40.
- Radius: 6.
- Label left, arrow right.
- Horizontal padding: 20.
- Font: SF Pro Text, 16 pt, semibold.
- Do not center the label in the Today primary CTA; it is left aligned with the arrow pinned right.
- Do not use pill buttons for primary actions in this design.

### 7.8 Secondary Button

- Fill: surfaceWarm or transparent.
- Border: border.
- Text: textPrimary.
- Height: 44-48.
- Radius: 6.
- Font: SF Pro Text, 15 pt, semibold.
- Use secondary buttons sparingly. Destructive actions must not look like the main forest CTA.

### 7.9 Bottom Tab Bar

The footer is part of the pixel contract.

- Surface: solid `tabSurface` / warm off-white, not translucent enough for content to visually bleed through.
- Top separator: 0.5 pt border.
- Height: about 74 pt including compact safe-area treatment.
- Active icon: forest, filled variant when available, e.g. `house.fill` for Today, about 22 pt.
- Inactive icons: thin line, tertiary text.
- Label: 12 pt SF Pro Text, medium. Active label semibold.
- Tabs: Today, Progress, Coach, Log, Profile.
- Suggested icons:
  - Today: `house.fill` active, `house` inactive.
  - Progress: thin bar chart icon.
  - Coach: speech bubble with dots.
  - Log: calendar/check style.
  - Profile: person outline.

Do not use a floating pill tab bar, icon blocks, colored capsules, or glassy blur that makes scrolling content visible underneath.

### 7.10 Today Metric Cards

These components exist only because the canonical Today reference includes them.

At a Glance:

- Three equal columns.
- Thin vertical dividers.
- Small icon above the value.
- Value uses a serif number/name.
- Label uses SF Pro Text, secondary color.

Daily Progress:

- Three rows.
- Left circular exercise thumbnail.
- Exercise label.
- Value and percent right aligned.
- Progress track height 3 pt.
- Track uses borderStrong; fill uses forest.

Bottom split card:

- Two equal columns.
- Vertical divider.
- Left column describes the next run.
- Right column describes tomorrow's next item and has a trailing chevron.

## 8. Data Visualization Rules

The app should use small, clear charts instead of large dashboards.

Use:

- Semi-circular progress arcs for goal progress.
- Thin sparklines for trend.
- Small bar charts for weekly running volume.
- Seven-day consistency squares.
- Simple progress bars for XP and targets.

Avoid:

- 3D charts.
- Complex multi-axis analytics.
- Huge pie charts.
- Neon gradients.
- Overlapping dashboard panels.

Charts should have very light gridlines or no gridlines. The number matters more than the chart decoration.

## 9. Iconography and Imagery

Icons:

- Thin line style.
- Native SF Symbols are acceptable.
- Use icons only when they improve scanning.
- Do not use cartoon icons.

Suggested SF Symbols:

- Today: `house.fill` active, `house` inactive
- Progress: `chart.bar`
- Coach: `bubble.left` or custom speech bubble with dots
- Log: `calendar.badge.checkmark` or `calendar`
- Profile: `person`
- Pull-ups: custom simple bar icon or `figure.strengthtraining.traditional`
- Running: `figure.run`
- Plank/core: `figure.core.training`
- Completion: `checkmark.circle.fill`

Imagery:

- Optional, sparse.
- Use monochrome athlete line illustrations or low-saturation outdoor/mountain photography.
- Images must never compete with the training prescription.
- Do not use glossy stock fitness models.

## 10. Voice and Microcopy

The app should sound like a precise coach, not a motivational speaker.

Good:

- “Leave one rep in reserve.”
- “Pull-ups are trending up.”
- “Today is volume, not max effort.”
- “5 of 7 sessions completed.”
- “Strength score improved by 6.”

Bad:

- “Crush your goals!”
- “Unleash beast mode!”
- “AI magic created your plan!”
- “No excuses!”
- “Dominate your workout!”

The tone should be calm, useful, and direct.

## 11. Motion and Interaction

Use subtle native motion.

Allowed:

- Progress arcs animate from 0 to current value when appearing.
- Completion checkmark softly fills.
- Cards use light press scale: 0.98.
- Segment control changes with native animation.
- Session completion may show a quiet success state.

Avoid:

- Confetti by default.
- Excessive haptics.
- Bouncy gamified animations.
- Pulsing/glowing UI.

Use haptics only for meaningful actions: completing a session, saving a log, starting a workout.

## 12. Accessibility Requirements

- Minimum touch target: 44 × 44 pt.
- Text must support Dynamic Type where practical.
- Do not encode status by color alone; use labels or icons too.
- Progress numbers must be readable without relying on charts.
- Contrast must be strong against warm background.
- VoiceOver labels should include metric values, e.g. “Pull-ups, 32 of 50, 64 percent.”

## 13. SwiftUI Implementation Guidance

Create a centralized design system rather than hardcoding colors and spacing.

Recommended files:

```text
FitnessApp/
  DesignSystem/
    LockinTheme.swift
    LockinColors.swift
    LockinTypography.swift
    LockinSpacing.swift
    LockinComponents.swift
    LockinCharts.swift
  Views/
    TodayView.swift
    ProgressView.swift
    CoachView.swift
    LogView.swift
    ProfileView.swift
```

Example SwiftUI theme structure:

```swift
enum LockinColors {
    static let background = Color(hex: "FAF8F2")
    static let backgroundSecondary = Color(hex: "F3F0E8")
    static let surface = Color(hex: "FFFFFF")
    static let surfaceWarm = Color(hex: "F7F4EC")
    static let border = Color(hex: "E4DED2")
    static let textPrimary = Color(hex: "171A15")
    static let textSecondary = Color(hex: "5F6258")
    static let forest = Color(hex: "203A24")
    static let olive = Color(hex: "73804A")
    static let warning = Color(hex: "B7791F")
    static let danger = Color(hex: "A14A3B")
    static let blueRunning = Color(hex: "3D6F91")
}

enum LockinSpacing {
    static let screen: CGFloat = 20
    static let cardPadding: CGFloat = 16
    static let cardGap: CGFloat = 12
    static let sectionGap: CGFloat = 24
}
```

Use reusable components for cards, progress arcs, sparklines, and consistency strips. Do not redesign every card independently.

## 14. Suggested Component Inventory for the Development Agent

Build these first:

1. `LockinCard`
2. `PrimaryActionButton`
3. `SectionLabel`
4. `GoalMetricCard`
5. `ProgressArc`
6. `SparklineView`
7. `ConsistencyStrip`
8. `WorkoutRowCard`
9. `CoachReadCard`
10. `RankProgressCard`
11. `CalendarDayMarker`
12. `MetricPill`
13. `SegmentedFilter`

Once these exist, rebuild each tab using the components.

## 15. Screen-by-Screen Acceptance Criteria

### Today acceptance criteria

- User can identify today’s main workout immediately.
- Main workout card is the visual focus.
- Primary CTA is obvious.
- Secondary planned items are visible but quiet.
- No dashboard clutter.

### Progress acceptance criteria

- Pull-ups, push-ups, and plank are visually prominent.
- Each goal clearly shows current, target, and percentage.
- Trend is visible without requiring deep analysis.
- Strength and running are separated by a clear segmented control.

### Consistency acceptance criteria

- Weekly completion is understandable at a glance.
- Strength score is easy to find.
- Level/XP is rewarding but not childish.
- Missed sessions are visible but not shame-heavy.

### Coach acceptance criteria

- Feels like a serious coach note, not a chatbot.
- Primary summary is readable in under 15 seconds.
- Generation actions are clear.
- Model settings are secondary.

### Log acceptance criteria

- Calendar states are scannable.
- Completed/planned/missed/deloaded statuses are clear.
- History list is readable and compact.

### Profile acceptance criteria

- Strength targets are visible.
- Running profile is visible.
- Equipment and injury notes are easy to edit.
- Dangerous reset actions are visually separated and clearly labeled.

## 16. What to Remove From the Current Direction

Remove or avoid:

- Neon green on black everywhere.
- Gamer badges as the main identity.
- Diamond/crypto rank styling.
- Big muscular hero photos.
- Purple AI brain cards.
- Extra dense metric dashboards on Today beyond the canonical `AT A GLANCE`, `DAILY PROGRESS`, and bottom split card.
- Overuse of dark mode.
- Generic motivational slogans.
- Too many competing cards.
- Progress screens that feel like a trading app.

Keep or strengthen:

- Pull-up, push-up, plank target progress.
- Consistency scoring.
- Strength score.
- Level/XP progression.
- Running preparation.
- Coach notes.
- Manual logging.

## 17. Reference Mental Model

The final app should feel like this combination:

- Strava: clear progress and athlete credibility.
- Apple Fitness: native polish and simple hierarchy.
- Patagonia: physical, outdoor, disciplined, non-gimmicky.
- Moleskine notebook: calm, personal, manual-first.
- A good coach: direct, specific, useful.

It should not feel like:

- A bodybuilding app.
- A crypto dashboard.
- A neon gaming app.
- A generic AI assistant.
- A motivational poster.

## 18. Development-Agent Prompt

Use this prompt when handing the redesign task to an implementation agent:

> Redesign the Lockin SwiftUI iPhone app using the Alpine Notebook design system defined in this file. Build a warm, calm, premium athlete-training interface. Preserve visible strength progression for pull-ups, push-ups, plank, consistency, strength score, levels, and XP, but remove neon/gamer/crypto aesthetics. Use warm off-white backgrounds, forest green progress, graphite text, soft white cards, thin borders, generous spacing, native iOS typography, and restrained motion. Today must follow the canonical title-case reference: date eyebrow, `Locked In.` serif hero, avatar, Today Work card, At a Glance, Daily Progress, bottom split card, and quiet native footer. Coach must feel like a human coach note, not an AI chatbot. Implement reusable SwiftUI components and apply them across Today, Progress, Coach, Log, Profile, Running, and Level/Achievement screens.

## 19. Final Design Principle

Lockin should make difficult training feel organized, measurable, and worth repeating.

The app should not yell at the athlete.

It should quietly show the work, track the standard, and make progress visible.
