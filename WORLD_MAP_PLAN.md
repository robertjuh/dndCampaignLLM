# Stable world map and contextual shortcuts

Status: implemented, 18 October 2026.

Implementation uses optional saved `worldMap.positions` and a deterministic radial
slot layout in `shared/world-map-layout.ts`. Database version 19 initializes
current campaigns; finalization/publication preserve positions across older
in-flight turns. Model payloads omit display coordinates. The React map uses a
local camera, native pointer/wheel handling and a modal dialog for expansion.
Contextual shortcut guidance keeps the existing route evidence and travel rules.

Verification: all **859 unit/integration tests in 40 files**, **3 focused browser
tests**, and the production build passed. Browser coverage includes phone/shared
views, touch pinch zoom, mouse/keyboard controls, incoming route/scene updates,
negative-coordinate growth, camera preservation and modal focus restoration.
The larger visual fixture contains 33 places, loops and split character positions.
Tests use isolated data and mocked adjudication; live shortcut frequency has not
been measured.

The map should grow into a web that players can learn: places keep their positions,
characters move between them, and discoveries sometimes reconnect existing
branches when the fiction supports it. Players control where they look with pan,
zoom and an expanded view.

## Original behavior

`src/WorldMap.tsx` calculates a breadth-first layout rooted at
`scene.location.id` on every render. Changing scene focus can therefore rearrange
the whole connected map. The viewport scrolls, but has no zoom controls.

The saved graph and travel rules already support cycles. `connectLocations()`
stores connections between distinct places without enforcing a tree, and
`server/providers.ts` already mentions loops and shortcuts. The work is to make
the layout stable and make contextual reconnections a clearer generation policy.

## Intended behavior

- Each location has a fixed shared position. Moving, changing scene focus,
  renaming a place, returning to it or adding a route leaves that position intact.
- Newly discovered places occupy free space near their connected places. Growth
  is organic, without compulsory rings or a direction based on player movement.
- Connections can close a circle such as courtyard → woods → mill → courtyard.
  Adding the final connection leaves all existing markers in place.
- Each viewer controls their own pan, zoom and selected location. New turns update
  markers and routes while preserving the view.
- The map represents known connections. Its drawing does not establish compass
  directions, travel distances, adjacency or hidden routes.

## 1. Save stable positions

Primary files: `shared/schema.ts`, `shared/locations.ts`, `server/game.ts` and a
small shared layout helper, with save initialization in
`server/location-migration.ts` / `server/db.ts` as needed.

- Add an optional `worldMap.positions` record keyed by location ID, containing
  finite `x` and `y` coordinates. Keep it separate from node descriptions because
  existing arrival/rename helpers replace those descriptions.
- Use one deterministic placement helper. Preserve assigned positions, process
  new nodes in stable order and search nearby slots with minimum marker/label
  spacing. Account for all already placed neighbours when choosing a slot.
- Anchor the first actual starting place at the origin. Initialize opening layout
  after placeholder locations have been removed. Put disconnected known groups
  in separate free space; connecting them later adds an edge without moving them.
- Assign missing positions after validated topology changes and save them with
  the existing campaign/draft JSON. Rendering uses these coordinates directly.
- Backfill missing positions for current saved campaigns once, deterministically.
  Cover legacy snapshots with the same deterministic fallback. Audit draft
  creation, finalization and publication so an in-flight pre-upgrade turn cannot
  discard the initialized positions. Preserve accepted gameplay checkpoints and
  completed history.
- Keep layout coordinates out of model inputs and model-authored map updates.
  The GM receives public locations and connections; the server owns placement.

No layout dependency or continuous physics simulation is needed. With positions
fixed, some long connections and crossings are expected; readability comes from
spacing and route highlighting rather than rearranging familiar places.

## 2. Render a readable web

Primary files: `src/WorldMap.tsx` and `src/style.css`.

- Replace the large always-expanded tiles with compact markers, readable names
  and small occupant indicators. Selecting a marker opens its name, visit status,
  characters and known routes in a nearby details panel.
- At overview scale, reduce secondary labels while keeping selected/occupied
  locations identifiable. Selection and keyboard focus always expose the name.
- Draw every saved connection, including cross-links and loops. End routes at
  marker boundaries; distinguish crossings from actual location junctions.
- Preserve visited/unvisited styling, blocked paths, one-way arrows, current
  scene focus, split-party positions and the accessible Routes list.
- Highlight a selected location's connections. Briefly highlight newly added
  places/routes, respecting reduced-motion preferences and avoiding replay on
  ordinary rerenders.
- Keep current-map labeling while viewing earlier turns, as the existing UI does.

## 3. Add navigation without view jumps

Primary files: `src/WorldMap.tsx`, `src/style.css` and its caller in `src/main.tsx`.

- Provide drag-to-pan, touch pinch zoom, zoom buttons and deliberate mouse-wheel
  zoom while interacting with the map. Preserve normal page scrolling outside
  that interaction, especially on phones.
- Zoom around the pointer or gesture midpoint. Keep screen positions stable when
  the map grows into negative coordinates or its bounds expand.
- Fit the map on first opening. Afterwards preserve the camera across ordinary
  turn updates, marker movement, route discoveries and container resizing.
- Add **Find me**, **Fit map** and **Expand** controls. The shared screen uses
  **Find scene** because it has no player character. Expanded view retains the
  camera when opened and closed.
- Support keyboard selection, panning and zooming; restore focus after closing
  expanded view. Provide English and Dutch labels.
- Keep camera state local to the viewer and separate from campaign positions.
  Selecting or navigating the map never submits movement.

## 4. Encourage shortcuts when the world supports them

Primary files: `server/providers.ts`; retain the evidence and locality checks in
`server/world-map.ts` and the existing travel rules.

Strengthen the current GM guidance: on arrivals, exploration and relevant world
changes, consider whether an observable route reasonably reconnects to an
established place. Reuse that place's saved ID and facts. A shortcut can be
discovered or opened, and it can be blocked or one-way where appropriate.

Examples include a mill's service trail returning to known woods, an unlocked
postern connecting to a visited courtyard, or an established lift being restored
between known levels. Enclosed rooms and isolated areas can remain dead ends.

There is no shortcut quota, timer, probability roll or requirement to make a
circle. Layout proximity alone is never evidence. A route must fit established
geography, barriers and events, and satisfy the existing public evidence and
occupied-endpoint rules. Hints about a distant destination do not become a direct
connection until the route is established. Narration describes the saved change.

Discovering a route does not move anyone automatically. Ordinary travel still
crosses one meaningful connection per turn; the existing gathering exception
continues to follow saved routes. No extra model stage or automatic generation
of remote connections is needed.

## 5. Verify and document

Extend the existing map, location and browser tests with focused regressions:

- Coordinates survive scene/player movement, revisits, renames, newly added
  nodes, a closing cycle, disconnected-group reconnection and save/reload.
- Existing saves initialize consistently; retries and in-flight legacy turns
  preserve placement without changing completed gameplay facts.
- A grounded shortcut between existing places is accepted, saved and usable by
  routing. Missing evidence, remote discovery and blocked/one-way violations
  remain rejected. A dead end remains valid.
- Phone, desktop and shared-screen views support selection, zoom, pan, fit/find
  and expansion, while preserving the camera through an incoming turn and map
  growth. Check long names, multiple occupants, keyboard access and page overflow.
- Use a representative larger fixture with branches, loops, blocked routes and
  split players to inspect readability. Mocked tests establish contracts and UI
  behavior; they do not establish how often a live GM chooses good shortcuts.

Run focused Vitest and Playwright tests, the production build, then the full
unit/integration suite because map metadata crosses shared save contracts.
Update the map description in `README.md` after implementation.

Implementation order: saved positions and compatibility → web rendering →
navigation → contextual shortcut guidance → verification and documentation.
Each step includes its focused regression checks.

The first version is complete when players can revisit familiar places without
the world shifting, explore the web at different scales, and discover a justified
connection back to a known place with correct saved travel behavior.
