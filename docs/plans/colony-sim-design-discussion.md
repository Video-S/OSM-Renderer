# Exploratory design — Regional colony simulation and A-Life-inspired world

**Recorded:** 2026-11-26  
**Status:** Authoritative record of this design discussion and agreed product direction; not a finalized game design or approved implementation plan. Explicit owner decisions take precedence over exploratory proposals and older notes.  
**Related:** [Persistent regional simulation](./persistent-regional-simulation.md) (earlier proposal, originally framed around Atom Zombie Smasher).

## 1. Change in game direction

The owner is moving away from an Atom Zombie Smasher-like game. Another developer has already executed that concept well. The emerging direction is a colony simulation set in real-world geography, initially Overijssel. Zombies remain a possible threat, not a settled requirement or the principal gameplay mechanic.

The player occupies existing buildings and places, constructs around them, manages colony production and needs, establishes outposts or other colonies, and arranges trade and supply lines. The geography should be economically meaningful rather than merely a combat backdrop. For example, an industrial estate, agricultural area and residential neighbourhood could offer different opportunities for settlement and specialization; these are illustrative possibilities, not finalized mechanics.

## 2. Colonies and economies

The owner confirmed that both relatively self-sufficient colonies and regional economic interdependence fit the concept. Interdependence applies wherever other economies exist: in solo play these may simply be the player's own colonies; with friends, the network can include their colonies as well.

Working design principles discussed:
- Colonies are distinct economic entities with their own production, consumption, inventories and needs.
- Players may control several settlements or outposts, potentially with different specializations.
- Resource transfers should have meaningful origins, destinations, travel times and transport constraints.
- Geography and existing infrastructure influence settlement location and logistics.
- Simulation continues in areas that are not being rendered.
- The same underlying economic model should support solo and cooperative play; ownership, access and trade rules are potential differences.

Neither compulsory trade nor AI-controlled economies have been specified. Production recipes, resources, colonist needs, population model, settlement boundaries, construction rules and combat are still open.

## 3. Client/server distinction

The owner wants a strict client/server distinction, potentially enabling friends living in Overijssel to join the same world. Multiplayer is a desired possibility rather than a commitment to a specific protocol, server stack or game mode.

Proposed responsibilities:
- **Server:** authoritative entities, colony economies, inventories, routes, construction, interactions, simulation clock and persistent world state.
- **Client:** render the relevant geographic and gameplay state, handle camera/UI/input and submit player commands.

Simulation data residency and fidelity must not be coupled to a client's render-tile loading, eviction or batching policy. No requirement to simulate while the server is shut down has been agreed.

## 4. A-Life-inspired two-layer simulation

The owner suggested an A-Life-like model: a virtual regional world with detailed "online" simulation instantiated in a local bubble around a player's presence (represented by their camera), and a regional view that displays simplified information from the "offline" model.

"Online" and "offline" here refer to simulation fidelity, not network connectivity.

| Aspect | Regional / offline | Local / online |
| --- | --- | --- |
| Coverage | Supported region, including unobserved areas | Server-selected relevant local areas |
| Agents | Graph positions, routes, tasks, travel times; possible aggregation | Individual spatial movement and interaction |
| Navigation | OSM-derived connectivity graph | Detailed local pathfinding and avoidance |
| Economy | Production, consumption, inventory, logistics | Same underlying economy with detailed execution where relevant |
| Combat, if included | Abstract resolution, if appropriate | Detailed spatial interactions |
| Geometry | No need for render meshes | Collision and navigation representation |

These are candidate layers, not a prescribed update-frequency hierarchy. The intention is one persistent authoritative world, not two independent simulations with conflicting inventories or duplicate agents.

The camera may request local activation, but the server decides fidelity using gameplay relevance and resource constraints. Important events may require detailed simulation even without an observing player. Regional view must not activate detailed simulation over the whole visible region. Overlapping player bubbles should refer to a single authoritative local simulation, not separate instances of the same settlement.

A critical invariant is continuity when crossing fidelity boundaries: retain agent identity where relevant, position/route progress, destination, current task, cargo/inventory, ownership and causally relevant events. Changing the camera should not itself create resources, duplicate agents or unfairly change outcomes. Exact equivalence between abstract and spatial movement/combat remains an open design problem; define intended semantics before implementation.

## 5. Geographic graph and detailed navigation

The owner expects a virtual graph derived from OSM to support simulation of many agents without loading their rendered environments.

Explore a dedicated simulation-specific baked dataset, sharing geographic coordinates and stable feature identities with the renderer but independent of render tile partitioning:
- Roads and pedestrian routes, with grade separation and connectivity respected.
- Building footprints, access points and relevant geographic features.
- Traversability and obstacles where useful for local navigation.
- Links between regional graph edges and local navigation areas.

Keep the static geographic graph separate from mutable gameplay restrictions such as barricades, blocked or destroyed roads/bridges, construction and territorial access. These changes should influence routing without rebaking the source OSM data.

Regional routing may use graph edge IDs, progress and travel time rather than frame-by-frame movement. Local navigation may require a navmesh, grid, flow fields or other spatial algorithms accounting for obstacles and player-built structures. The particular algorithms and representations are not selected.

Illustrative example: a supply convoy travels from Enschede to Almelo via abstract graph progression. Near a settlement requiring detailed interactions, it transitions into local movement, navigates around obstacles and reaches its warehouse. Its cargo, task and route remain continuous across the handoff.

OSM's available tags and footprints do not establish reliable building capacities, occupancy, interior layouts, production capabilities or all actual access points. Gameplay abstractions and additional sources may be necessary.

## 6. Rendering implications and the unresolved navigation requirement

The project began with a detailed real-world map renderer, but the new game concept does not necessarily require identical geographic geometry at all zoom levels.

The owner explicitly questions how smooth and granular map navigation needs to be. Three operational scales were discussed:

| Scale | Main purpose | Candidate visual detail |
| --- | --- | --- |
| Local | Occupation, construction, colonists, defence | Detailed buildings and surroundings |
| Settlement | Production, infrastructure, expansion | Recognizable buildings and transport networks |
| Regional | Trade, expeditions, supply lines, other colonies | Simplified geography, routes, settlements and threats |

A possible architecture is two rendering representations: a detailed local renderer using existing baked geometry, and a lightweight regional strategic renderer driven by geographic and simulation data. Zooming could transition between these representations, or distinct camera modes could be used. Smooth movement within a local online bubble is desirable; seamless full-detail navigation across all of Overijssel is not yet a settled requirement. Regional views might show abstract agent or convoy positions without instantiating detailed movement.

This may enable smaller local streaming units and avoid replacing equivalent detailed geometry merely to change batching resolution. This is a hypothesis, not a measured result or a decision to abandon the current renderer.

### 6.1 Clarified navigation requirement: regional-to-local travel with a polished transition

The owner clarified that streaming remains necessary. A player should be able to navigate the regional map, select or approach an event, and enter its detailed local environment with a somewhat seamless transition. The owner explicitly accepts a loading screen concealed or presented through a deliberate visual transition (for example, a fade, camera animation or stylized transition). Completely invisible loading and uninterrupted full-detail zoom across the region are not requirements. Smooth local navigation and responsive regional navigation remain goals; distant jumps need not stream detailed geography along the intervening route.

Illustrative interaction:
1. The player notices an event or another colony on the lightweight regional map and selects a destination.
2. Destination preparation begins immediately, overlapping camera movement where possible. Detailed geographic assets stream in while the server independently prepares or activates the relevant local simulation.
3. The client presents detailed local geography and individual agents when the corresponding data is ready, allowing local interaction.

An explicit destination is a stronger prefetch signal than inferred camera velocity alone. Free navigation should remain possible, but selecting an event provides a useful opportunity to prioritize the destination.

Candidate streaming principles:
- Keep the regional representation lightweight and readily available as a visual fallback.
- Stream local detail in relatively small, bounded units, prioritizing the destination and visible coverage.
- Use the regional representation as a possible visual fallback while local coverage prepares, or use an intentional loading transition. Avoid accidental blank views; do not require the full-detail region to become resident.
- Keep client geometry readiness separate from authoritative server simulation readiness. Rendering completion must not control world progression.
- Coordinate the transition so detailed interactions are enabled only when the necessary authoritative state is available. The precise visual handoff, readiness criteria, acceptable loading duration and cancellation behavior remain design questions. Destination preloading is desirable for reducing waits, not a requirement that every transition complete without visible loading.

This preserves the usefulness of existing asynchronous preparation, cache management, prioritization and frame-budgeted scheduling. It does not imply that the current uniform-resolution atomic swap is the required mechanism for switching between strategic and local representations.

### 6.2 Resource headroom and static asset distribution

The owner agreed that renderer resource headroom and geographic asset distribution deserve architectural attention before relying on a minimal gameplay prototype, which may not represent the eventual product's workload.

A future renderer should reserve meaningful CPU, GPU and memory capacity for agents, animations, construction, UI and other gameplay workloads. Evaluate representative synthetic workloads without requiring finalized gameplay mechanics. No numerical headroom targets have been selected.

Localhost streaming benchmarks do not establish multiplayer asset-delivery performance. Investigate immutable, versioned geographic packages that clients can download or cache across sessions, separately from live authoritative gameplay state and updates. Client and server must agree on the geographic dataset identity. Distribution, cache invalidation, storage limits and installation versus browser caching remain open decisions.

The owner agreed to work toward a renderer supporting this revised goal. After F2, the proposed development order is: evaluate a lightweight regional representation, integrate regional-to-local navigation and destination preparation, investigate static asset distribution and persistent caching, then validate resource headroom under representative synthetic gameplay workloads. The sequence is a proposal, not an approved set of tickets or authorization to begin a replacement renderer.

## 7. Relationship to ongoing renderer work

TKT-041 introduced uniform-viewport hierarchical render batching; F1 improved severe frame-time stalls but large-resolution activation remains slow and pending for too long in owner testing. F2 is currently being worked on (streaming throughput, bounded independent stages, scheduling, prewarming and delivery-granularity feasibility).

Allow F2 to establish what is recoverable from the existing pipeline. Its outcome should inform future renderer decisions, but do not assume further optimization or a redesign is required before defining gameplay. In particular, rendering batch size, storage/delivery granularity and simulation partitioning need not be identical.

The discussion suggests reviewing game requirements before another major rendering redesign. If regional visual fidelity is not needed, a deliberately simpler strategic representation may be a better fit than streaming the same geometry at multiple batch sizes. Keep existing renderer correctness and performance work valuable and reusable.

## 8. Open questions for a future design session

- What is the primary gameplay loop, player interaction model and meaningful timescale?
- How detailed must local building occupation, construction and colonist behaviour be?
- How much continuous local camera movement, and what transition to regional view, feels appropriate?
- What determines online bubble size, activation, deactivation, retention and server resource limits?
- How are graph-to-spatial handoffs and equivalent economic/combat semantics validated?
- How are agents, convoys and colony tasks represented at each fidelity level?
- How do dynamic construction and road closures update local navigation and regional connectivity?
- How should player permissions, cooperation, trade, persistence, reconnects and server downtime work?
- Which geographic data is necessary for gameplay, and which details can be omitted from rendering?
- What threats (including possible zombies) best serve the colony and logistics mechanics?

## 9. Scope guard

This is the authoritative record of this discussion, including agreed requirements and explicitly identified exploratory ideas. It is not a formal ADR, finalized game design, approved ticket or commitment to an engine, server language, networking implementation or pathfinding algorithm. Update this document as the owner clarifies the direction; do not treat superseded discussion wording as an active requirement. Do not start gameplay implementation, a simulation bake or a renderer replacement solely on the basis of these notes. No existing ticket status is changed.
