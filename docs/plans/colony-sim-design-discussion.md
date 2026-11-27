# Exploratory design — Regional colony simulation and A-Life-inspired world

**Recorded:** 2026-11-26  
**Updated:** 2026-11-27  
**Status:** Authoritative record of this design discussion and agreed product direction; not a finalized game design or approved implementation plan. Explicit owner decisions take precedence over exploratory proposals and older notes.  
**Related:** [Persistent regional simulation](./persistent-regional-simulation.md) (earlier proposal, originally framed around Atom Zombie Smasher).

## 1. Change in game direction

The owner is moving away from an Atom Zombie Smasher-like game. Another developer has already executed that concept well. The emerging direction is a colony simulation set in real-world geography, initially Overijssel. Zombies remain a possible threat, not a settled requirement or the principal gameplay mechanic.

The player makes use of existing buildings and places, constructs around them, manages colony production and needs, establishes outposts or other colonies, and arranges trade and supply lines. The term occupation is not yet a defined gameplay mechanic; see section 10. The geography should be economically meaningful rather than merely a combat backdrop. For example, an industrial estate, agricultural area and residential neighbourhood could offer different opportunities for settlement and specialization; these are illustrative possibilities, not finalized mechanics.

## 2. Colonies and economies

The owner confirmed that both relatively self-sufficient colonies and regional economic interdependence fit the concept. Interdependence applies wherever other economies exist: in solo play these may simply be the player's own colonies; with friends, the network can include their colonies as well.

Working design principles discussed:
- Colonies are economic organizations with production, consumption and needs; resources belong to specific inventories, not a colony-wide spendable pool. Geographic boundaries are not required by the current design.
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

TKT-041 introduced uniform-viewport hierarchical render batching; F1 improved several severe frame-time stalls but large-resolution activation remained slow. F2 closed on 2026-11-27 with owner-accepted improvements to transition latency, although frame pacing remains mixed, concurrent preparation increases peak accounted memory, and large consolidated tiles remain indivisible payloads. The owner has mentioned some unspecified issues with the new map; these have not been diagnosed. See [current status](../STATUS.md) and [current architecture](../architecture/overview.md) for implementation details.

The existing pipeline remains useful as a reference and local-rendering foundation. Further uniform full-detail hierarchy optimization is deferred. Rendering batch size, storage/delivery granularity and simulation partitioning need not be identical.

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

## 10. Gameplay design discussion — 2026-11-27

This section records the latest owner decisions and exploratory ideas. It refines earlier wording about occupation, colonies and gameplay. It does not finalize mechanics or authorize implementation.

### 10.1 Player agency and core loop

- The player plans operations and observes their execution. Success should depend on planning and management, not RTS-style direct unit control, reaction speed or micromanagement.
- Begin with a group of autonomous agents at a selected real-world starting location. Whether initial setup includes one or several buildings is open.
- Agents independently satisfy basic needs, consuming resources. Early acquisition can rely on looting and scavenging; later operations can establish production, transport and construction.
- The intended control model is configurable tasks/jobs. Examples include producers, transporters, builders, security personnel, scouts and looters. Configurable responsibilities, not direct control of movement or combat, are the working direction.
- Security assignments may specify checkpoints, patrol routes and shifts. Production assignments may specify shifts, roles, input and output inventories. The precise assignment model, priorities and amount of automatic delegation remain open.
- Mismanagement may lead to unreliable agents: for example, exhausted personnel may fail to carry out an assignment. The desired challenge is planning for such systemic consequences, rather than arbitrary failures. Agent empathy, attachment and interpersonal relationships are not committed systems.

### 10.2 Population and pressure

- Design around hundreds of individually simulated agents, not cities of thousands, tens of thousands or hundreds of thousands of colonists. This is a target scale, not a measured capacity or a hard numerical cap. The exact per-colony and total multiplayer populations are open.
- Recruitment, population growth, long-term success conditions and progression remain undecided.
- Zombies are a candidate source of pressure, not a requirement. Other colonies, including other players, are also potential sources of pressure and interaction. No threat or combat system has been finalized.

### 10.3 Localized economy and production

- Every resource must have a logical storage location. No globally spendable resource pool of the Age of Empires/StarCraft type.
- Resources do not need to exist as individually rendered or physically simulated objects. Inventories, cargo and production inputs/outputs can be abstract quantities. Transfers nevertheless require actual movement between locations.
- Agents carrying resources retain their cargo and destination in the regional abstraction as well as local simulation. Storage capacities, resource units, reservation rules, production recipes and automatic local distribution versus explicit supply routes are open.
- Basic production should generally be achievable at most starting locations given the necessary inputs and investment. Players should be able to choose familiar locations such as their home or workplace and make them viable, while strategic location choices improve their prospects.
- Existing specialized buildings can offer production advantages compared with conversions. Some rare resources may require particular production capabilities. A specific resource list, conversion costs, production requirements and geographic constraints remain exploratory.

### 10.4 Buildings, occupation and security

- Do not require detailed procedural interiors, indoor navigation, room layouts or individual workstations for the current design. Internal activities can be abstracted; agents should still visibly approach and enter buildings and leave when appropriate in the local view.
- Buildings should have a primary purpose, with secondary capabilities where appropriate. A home can support sleeping, cooking and some limited storage. Dedicated facilities and building conversions are possible as operations develop. Exact capacities and specialization rules are open.
- Avoid prematurely defining occupation/control as a binary territory or safe-zone mechanic. The owner questioned what occupation should actually mean: designation, assigned jobs, active production, access, modification, or map presentation. These must not be conflated.
- A candidate model separates persistent building configuration/modifications, access, scheduled activity, inventories and actual security conditions. A building need not be continuously staffed merely to remain configured or retain modifications. Ownership and multiplayer permissions are distinct questions still to be designed.
- Security is an area operation, not a mandatory permanent guard at every building. Patrols, checkpoints and schedules are intended to matter. The owner does not want restrictive safe zones to determine where operations are allowed.
- Concrete example: a production site may be left unattended overnight while threats approach it. Security personnel could be scheduled to arrive before the morning production shift. Workers then travel to the site according to their schedules. The player chooses how to organize this rather than being required to maintain continuous territorial coverage. The detailed rules for detection, clearing, entry, delay, retreat and failure are not yet selected.
- Whether a colony has any formal spatial boundary, and how disconnected facilities are grouped, remain open. Do not equate economic affiliation with geographic control.

### 10.5 Regional and local representations

- The local map has a substantially clearer purpose than the regional map: observe individual agents, buildings and operations in their detailed geographic environment.
- Regional simulation must still respect geography. A transporter travelling between locations should have a real route through the OSM-derived network, with meaningful travel progress and cargo. A* or a similar routing algorithm is a candidate, not an algorithm commitment.
- Local agents must visibly carry out movement and activities; abstract travel is not a substitute for local execution. The regional view may represent moving agents or transports as abstract icons driven by the same authoritative state.
- The regional map is likely to support observation and larger-scale planning (e.g. configuring regional supply routes). Its presentation, visual detail, available information, editing controls and precise role are not settled. Avoid designing its renderer in isolation from these gameplay requirements.
- The A-Life-inspired distinction is fidelity, not existence: the same agent, task, cargo and route must remain continuous between representations. Detailed and abstract execution must not independently advance the same activity or create inconsistent economic outcomes.

## 11. Technical feasibility and architecture implications

The discussion identified a plausible fit with the current renderer, not proven simulation performance. Current repository architecture (see [architecture overview](../architecture/overview.md)) supplies an immutable, spatially indexed OSM source, geographic feature metadata, projected coordinates in the baked path, graph-informed road/rail rendering, selectable buildings, baked static geometry, worker-based preparation and streaming. It does not implement gameplay, a validated region-wide routing network, local pedestrian navigation, an authoritative simulation server or agent rendering.

### 11.1 Reuse and remaining work

| Existing foundation | Potential gameplay use | Limitation / missing work |
| --- | --- | --- |
| Canonical OSM SQLite store and feature tags | Building catalog, resource/production opportunities, geographic context | Tags and footprints do not establish reliable interiors, inventories, capacities or actual production capability |
| InfrastructureGraph and grade-separation logic | Input to regional routing and local connectivity | Render-oriented, independently synthesized per shard; no validated global navigation connectivity, travel/access rules or cross-shard routing guarantee |
| Aligned UTM coordinates and feature metadata/picking | Associate simulation objects with buildings, roads and map selections | Define snapshot-qualified stable gameplay IDs, mapping and coordinate contracts; do not identify gameplay objects by mesh or tile lifetime |
| Baked detailed geometry, shared materials and BVHs | Local scene, selection, overlays and spatial queries | Render meshes are not inherently collision/navigation data; merged buildings require an explicit strategy for showing mutable modifications |
| Asynchronous tile preparation and streaming | Destination loading, local camera movement, bounded residency | Gameplay headroom and multiplayer asset distribution are unproven; consolidated full-detail hierarchy is not automatically suitable for a strategic map |
| Existing HTTP client/server split | Delivery of immutable geographic data | Authoritative simulation, commands, state synchronization, persistence and multiplayer permissions still need to be built |

A dedicated simulation bake derived from the same immutable geographic snapshot remains the working architectural proposal. It could contain compact regional connectivity, building footprints and semantic records, plausible access locations, traversability and local navigation inputs without loading expensive visual geometry on the server. Regional routing and local obstacle-aware movement should interoperate; dynamic changes such as barricades and blocked routes need mutable overlays. No navigation representation (navmesh, grid, flow fields or hybrid) has been selected.

Keep persistent building, inventory, job, schedule and agent state independent of render tile residency. The client can project authoritative state onto static geography and display dynamic overlays or entities. The server decides simulation fidelity and handles overlapping local areas; the camera and tile completion must not dictate whether time or economic activity progresses.

### 11.2 Expected difficulty and evidence limits

- Inventories, basic needs, building configurations, production and scheduling are expected to be comparatively inexpensive computationally; event-driven progression is a candidate for activities that do not need continuous updates.
- The more substantial engineering challenges are job arbitration and autonomous behaviour under competing needs, pathfinding and avoidance, changing obstacles, threat perception, coordinating shifts and resource reservations, and fidelity handoffs.
- The morning-security example is a useful future scenario for reasoning about scheduling, travel, readiness and failure. It is not yet an implementation specification or test acceptance contract.
- Hundreds of agents appear plausible on the current stack, but no gameplay workload has been measured. Rendering benchmark success does not prove simulation throughput, resource headroom, synchronization cost or large threat populations. Multiple detailed areas in multiplayer may increase the load.
- No current evidence requires an engine or language migration. Retaining the existing stack is a reasonable working hypothesis, not a final technology decision.

## 12. Design-first direction before further renderer architecture commitments

**Owner priority (2026-11-27):** Figure out what the game should actually do, then determine how the renderer, streamer and supporting systems must be built around those requirements. The owner expects significant further thought; technical feasibility does not settle the design.

The regional representation is especially uncertain because its intended gameplay has not yet been defined in sufficient detail. Do not treat the prior proposal to evaluate a lightweight regional renderer as authorization to choose a representation or start implementation now. Continue exploratory game design first. Preserve existing renderer work and its known limitations; the local map is comparatively well understood.

Questions to resolve before committing to major architecture changes:

- Which activities, information, decisions and feedback belong in local versus regional play? What should be visible at each scale, and what remains unknown to the player?
- How are jobs configured, assigned, scheduled, interrupted and resumed? What makes a plan fail, and what should the player be able to diagnose?
- What are the needs, resources, storage, production, building capabilities, progression and threat mechanics that must be supported?
- What movement, access, security and construction semantics require spatial precision? What can be resolved without detailed geometry?
- What fidelity transitions, camera navigation and destination preparation are necessary for the actual gameplay? A polished loading transition remains acceptable; continuous full-detail regional zoom is not a requirement.
- What simulation data must be globally available, what local detail is needed, and how should simulation partitioning, static asset packages, network delivery, render batching and cache residency differ?
- How much client and server resource headroom is required for representative agent, animation, UI, construction and multiplayer workloads?

Use these answers to derive requirements for local geometry and streaming, regional representation, static asset delivery, simulation baking, state synchronization and resource budgets. Only then select architecture and define scoped implementation work. The previous renderer-first development sequence in section 6.2 is a candidate technical sequence subject to this design-first gate, not a current task list.

No gameplay implementation, new bake, renderer redesign or ticket status changes are authorized by this discussion.
