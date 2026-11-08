# Mathematical Model: Independent Road-Surface & Junction Reconstruction

## 1. Design Philosophy & Scope Isolation

This model reconstructs plausible physical motor-vehicle carriageway surfaces and junction polygons purely from OpenStreetMap (OSM) linear ways and tags in a metric projected coordinate system (`EPSG:28992`, Amersfoort / RD New meters).

- **Complete Independence**: Developed from first principles without importing, reusing, or targeting the production renderer's Stage E2 (`GraphRoadGeometryBuilder.ts`) code, visual outputs, or fixtures.
- **Asymmetric Physical Representation**: Rather than assuming road surfaces are constant-width symmetric ribbons centered on OSM ways, each road segment carries independently varying left and right lateral offsets $(w_L(s), w_R(s))$ along arc length $s$.
- **Explicit Evidence Hierarchy**: Prioritizes explicit physical measurements (`width:carriageway`, `width`), lane-striping topology (`lanes`, `lanes:forward`, `lanes:backward`, `turn:lanes`), on-road cycleway lanes (`cycleway*=lane`), and lateral placement tags (`placement=*`) over unobserved highway-class defaults.
- **General Junction Geometry**: Constructs junction core surfaces, tangent quadratic Bézier curb fillets, and acute `placement=transition` taper flares from oriented half-edge boundaries while preserving physical traffic islands.

---

## 2. Reference Curves & Asymmetric Cross-Section Profiles

Let each at-grade drivable OSM way segment $e \in E$ be represented in projected metric coordinates (`EPSG:28992`) by a piecewise-linear reference curve:
$$\gamma_e : [0, L_e] \to \mathbb{R}^2, \qquad s \mapsto \gamma_e(s)$$
where $s$ is cumulative Euclidean arc length and $L_e > 0$ is total segment length in meters.

At each interior vertex $\mathbf{p}_i = \gamma_e(s_i)$, let $\mathbf t_{i-1}, \mathbf t_i \in S^1$ be the unit tangent vectors of the incoming and outgoing segments, and $\mathbf n_{i-1} = \mathbf t_{i-1}^\perp$, $\mathbf n_i = \mathbf t_i^\perp$ be their leftward unit normals ($\mathbf t^\perp = (-t_y, t_x)$). The mitered vertex normal is:
$$\tilde{\mathbf n}_i = \min\!\left(M_{\max},\; \frac{1}{\max(0.35,\; \hat{\mathbf b}_i \cdot \mathbf n_i)}\right) \hat{\mathbf b}_i, \qquad \hat{\mathbf b}_i = \frac{\mathbf n_{i-1} + \mathbf n_i}{\|\mathbf n_{i-1} + \mathbf n_i\|}$$
with miter cap $M_{\max} = 2.0$.

Each segment $e$ carries an independent lateral cross-section profile $(w_L(s), w_R(s))$ interpolated linearly between start ($s=0$) and end ($s = L_{\text{taper}} \le L_e$) offsets:
$$\partial L_e(s_i) = \gamma_e(s_i) + w_L(s_i)\,\tilde{\mathbf n}_i, \qquad \partial R_e(s_i) = \gamma_e(s_i) - w_R(s_i)\,\tilde{\mathbf n}_i$$
The total physical width at station $s$ is $W_e(s) = w_L(s) + w_R(s)$.

---

## 3. Hierarchical Evidence Model for Width & Lateral Placement

### 3.1 Vehicular Width Inference (Four-Tier Hierarchy)

For each way $e$, the vehicular carriageway width $W_{\text{veh}}(e)$ and uncertainty $\sigma_w(e)$ are estimated using the highest available tier:

1. **Tier 1 — Explicit Width Tag (`explicit_width_tag`, $\sigma_w = 0.35\text{ m}$)**:
   Valid numeric value in $[1.8\text{ m}, 35.0\text{ m}]$ from `width:carriageway`, `width`, or `est_width`. On-road cycleway lane offsets $(c_L, c_R)$ are subtracted to isolate $W_{\text{veh}} = \max(1.8\text{ m}, W_{\text{tagged}} - c_L - c_R)$.
2. **Tier 2 — Explicit Lane & Turn-Lane Evidence (`explicit_lanes_tag` / `explicit_turn_lanes`, $\sigma_w = 0.55\text{ m}$)**:
   Let $N_{\text{lanes}}$ be `lanes`, $N_{\text{dir}} = \text{lanes:forward} + \text{lanes:backward}$, and $N_{\text{turn}}$ be the number of pipe-delimited tokens in `turn:lanes` (or `turn:lanes:forward` + `turn:lanes:backward`).
   - When `turn:lanes` contains a merging lane token (`merge_to_right` or `merge_to_left`) and $N_{\text{turn}} > N_{\text{lanes}}$, the segment starts at $N_{\text{turn}}$ lanes at $s=0$ and tapers linearly over $L_{\text{taper}} = \min(L_e, 18.0\text{ m})$ down to $N_{\text{lanes}}$ lanes.
   - Otherwise, the effective lane count is $N_{\text{eff}} = \max(N_{\text{lanes}}, N_{\text{dir}}, N_{\text{turn}})$ and $W_{\text{veh}} = N_{\text{eff}} \cdot w_{\text{lane}}(\text{highway})$, where class-conditioned single-lane widths $w_{\text{lane}}$ range from $3.50\text{ m}$ (`motorway`) and $3.25\text{ m}$ (`primary`/`secondary`) to $2.90\text{ m}$ (`residential`) and $2.75\text{ m}$ (`service`).
3. **Tier 3 — Topological Collinear Continuation (`topological_continuation`, $\sigma_w = 0.75\text{ m}$)**:
   Across shared topological nodes, if an untagged segment ($e_a$) meets a Tier 1/Tier 2 segment ($e_b$) of the same `highway` class and `oneway` status at a near-collinear deflection angle $\Delta\theta \le 28^\circ$ (with consistent head-to-tail flow for one-way roads), $e_a$ inherits $W_{\text{veh}}(e_b)$ up to 2 topological hops.
4. **Tier 4 — Class- and Direction-Conditioned Fallback (`class_fallback`, $\sigma_w = 1.25\text{ m}$)**:
   Conservative fallback widths distinguishing two-way vs. one-way streets (e.g., `residential`: $5.3\text{ m}$ two-way vs. $4.1\text{ m}$ one-way; `unclassified`: $5.3\text{ m}$ two-way vs. $4.4\text{ m}$ one-way; `tertiary`: $6.0\text{ m}$ two-way vs. $5.8\text{ m}$ one-way).

### 3.2 On-Road Cycleway Lanes (`cycleway*=lane`)

When OSM tags indicate an on-road painted cycle lane (`cycleway=lane`, `cycleway:left=lane`, `cycleway:right=lane`, `cycleway:both=lane`, or `opposite_lane`), an additional curb offset $c_L, c_R = 1.55\text{ m}$ (or `cycleway:*:width` if explicitly tagged) is added to the corresponding side(s) of the carriageway. Separately mapped cycle tracks (`cycleway*=track` or `separate`) are excluded from carriageway widening.

### 3.3 Asymmetric Lateral Placement (`placement=*` & Turn-Lane Splits)

Let lanes $1, \dots, N$ be indexed from left to right in the way direction, each of width $\bar w = W_{\text{veh}} / N$.

1. **Explicit `placement` Tags (`placement`, `placement:start`, `placement:end`)**:
   - `left_of:k`: $N_L = k - 1$ lanes lie to the left of $\gamma_e$; $N_R = N - (k - 1)$ lie to the right.
   - `middle_of:k`: $N_L = k - 0.5$ lanes lie to the left of $\gamma_e$; $N_R = N - (k - 0.5)$ lie to the right.
   - `right_of:k`: $N_L = k$ lanes lie to the left of $\gamma_e$; $N_R = N - k$ lie to the right.
   This yields vehicular offsets $w_{\text{veh},L} = N_L \bar w$ and $w_{\text{veh},R} = N_R \bar w$.
2. **Inferred Turn-Lane Split Asymmetry**:
   When a multi-lane one-way approach with $\ge 3$ `turn:lanes` tokens (e.g., `left|through|through` with $N_{\text{left}}=1$, $N_{\text{through}}=2$) terminates at a junction node where a main line continues collinearly ($\Delta\theta \le 20^\circ$) and a turn branch diverges, the through lanes remain centered on the main line while the dedicated turn lane projects onto the branching side:
   $$N_L = N_{\text{left}} + \tfrac{1}{2} N_{\text{through}}, \qquad N_R = N_{\text{right}} + \tfrac{1}{2} N_{\text{through}}$$

---

## 4. General Junction Surface Construction

At every topological node $v \in V$ (snapped within $\varepsilon_{\text{snap}} = 0.05\text{ m}$) with degree $d = \deg(v) \ge 2$:

### 4.1 Outward Half-Edge Orientation

Each incident road segment $e_k$ is converted into an **outward half-edge** $h_k$ starting at $\tilde{\gamma}_k(0) = \mathbf p_v$ and parameterized outward along arc length $s \in [0, L_k]$.
- If $e_k$ starts at $v$, its outward-left and outward-right boundaries are $(\partial L_{e_k}, \partial R_{e_k})$.
- If $e_k$ ends at $v$, its polyline is reversed and its outward-left and outward-right boundaries are $(\text{rev}(\partial R_{e_k}), \text{rev}(\partial L_{e_k}))$.

Half-edges $\{h_0, \dots, h_{d-1}\}$ are sorted counter-clockwise by their initial outward tangent angle $\theta_k$ (measured over $\min(L_k, 3.5\text{ m})$).

### 4.2 Junction Node Core Polygon

Because individual corridors are constructed with flat end-caps at $s=0$ and $s=L_e$, meeting corridors at an angled bend or intersection leave an open wedge between their endpoint curb pairs $(\partial R_k(0), \partial L_k(0))$. The junction core closes this wedge via the convex hull of the endpoint curb vertices $\bigcup_{k=0}^{d-1} \{\partial R_k(0), \partial L_k(0)\}$ unioned with compact endpoint join disks centered at $\frac{1}{2}(\partial L_k(0) + \partial R_k(0))$ of radius $\frac{1}{2}\|\partial L_k(0) - \partial R_k(0)\|$.

### 4.3 Tangent Quadratic Bézier Corner Curb Fillets

For each angularly adjacent pair $(h_k, h_{k+1 \bmod d})$ with interior turn angle $\Delta\theta_k = (\theta_{k+1} - \theta_k) \bmod 2\pi \in [22^\circ, 162^\circ]$:
1. Trim the outward-left curb $\partial L_k$ of $h_k$ and the outward-right curb $\partial R_{k+1}$ of $h_{k+1}$ to a localized search reach $s_{\max} = \min(0.45 L, 9.0\text{ m})$.
2. If $\partial L_k$ and $\partial R_{k+1}$ intersect at $\mathbf p_{\text{int}}$ at arc lengths $(s_k^*, s_{k+1}^*)$, advance outward along each curb by a hierarchy-conditioned tangent offset $\delta_t \in [1.2\text{ m}, 3.2\text{ m}]$ to tangent points:
   $$\mathbf p_A = \partial L_k(\min(L_k, s_k^* + \delta_t)), \qquad \mathbf p_B = \partial R_{k+1}(\min(L_{k+1}, s_{k+1}^* + \delta_t))$$
3. Construct the quadratic Bézier curve tangent to $\partial L_k$ at $\mathbf p_A$ and tangent to $\partial R_{k+1}$ at $\mathbf p_B$ with control point $\mathbf p_{\text{int}}$:
   $$\mathbf B(t) = (1-t)^2 \mathbf p_A + 2(1-t)t\,\mathbf p_{\text{int}} + t^2 \mathbf p_B, \qquad t \in [0, 1]$$
4. Form the closed corner fillet polygon bounded by $\mathbf p_{\text{int}} \to \mathbf p_A \to \mathbf B(t) \to \mathbf p_B \to \mathbf p_{\text{int}}$.

### 4.4 Acute `placement=transition` Taper Flare Bridging & Island Preservation

- **Taper Flare Bridging**: When two half-edges diverge or merge at an acute angle $\Delta\theta_k \in [8^\circ, 50^\circ]$ and at least one branch carries explicit transition or asymmetric placement evidence (`placement=transition`, `explicit_placement_tag`, or `inferred_turn_lane_split`), the narrow gore between $\partial L_k(s)$ and $\partial R_{k+1}(s)$ is bridged longitudinally up to where the curb-to-curb separation reaches $4.2\text{ m}$ (capped at $18.0\text{ m}$ reach and $35.0\text{ m}^2$ area).
- **Physical Island Preservation**: Unpaved interior loops enclosed by the road network with area $\ge 8.0\text{ m}^2$ that do not adjoin a `placement=transition` gore are explicitly preserved as unpaved physical traffic islands / medians.

---

## 5. Documented Tolerances & Constraint Verification

| Parameter | Symbol | Value | Purpose |
| :--- | :--- | :--- | :--- |
| Node snap tolerance | $\varepsilon_{\text{snap}}$ | $0.05\text{ m}$ | Quantizes endpoint coordinates in `EPSG:28992` to match shared nodes |
| Miter limit | $M_{\max}$ | $2.0$ | Prevents unbounded miter spikes at sharp interior polyline vertices |
| Collinear continuation max angle | $\Delta\theta_{\text{cont}}$ | $28.0^\circ$ | Maximum deflection angle for propagating explicit lane counts |
| Junction fillet turn angle bounds | $[\theta_{\min}, \theta_{\max}]$ | $[22^\circ, 162^\circ]$ | Excludes parallel carriageways ($<22^\circ$) and straight continuations ($>162^\circ$) |
| Junction curb search reach | $s_{\max}$ | $\min(0.45 L, 9.0\text{ m})$ | Confines corner curb intersections to the immediate junction neighbourhood |
| Maximum single fillet area | $A_{\text{fillet},\max}$ | $18.0\text{ m}^2$ | Prevents uncontrolled web expansion across wide acute gaps |
| Maximum transition flare area | $A_{\text{flare},\max}$ | $35.0\text{ m}^2$ | Bounds `placement=transition` gore bridging |
| Minimum preserved island area | $A_{\text{island},\min}$ | $8.0\text{ m}^2$ | Distinguishes real traffic islands from numerical sliver holes |

### Explicit Fallback Hierarchy

Every corridor and junction polygon is validated for finite coordinates, non-emptiness, topological validity (`is_valid`), and area bounds:
1. If a variable-width offset polygon self-intersects on a tightly curved way, `buffer(0)` topological repair is attempted and recorded as `corridor_self_intersection_repaired_buffer0`.
2. If the repaired polygon is degenerate ($A < 0.5 L_e$), the segment falls back to a flat-capped miter buffer of average half-width and records `corridor_degenerate_fallback_buffer`.
3. Any candidate corner fillet or transition flare that fails validity or exceeds $A_{\text{fillet},\max}$ / $A_{\text{flare},\max}$ is rejected without corrupting adjacent corridors.
