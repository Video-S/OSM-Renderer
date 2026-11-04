# Camera and World Coordinates

## 1. Geographic Coordinate System & Projection

The map viewer transforms spherical geographic coordinates from the **WGS84** datum (EPSG:4326) into a local Euclidean metric space via `src/world/WorldCoordinates.ts`.

### Projection Model
- **Local Equirectangular Tangent Projection**: The local coordinate system is anchored at the dataset's geographic centroid `(originLon, originLat)`.
- **Projection Formula**:
  $$x = R_{\text{WGS84}} \cdot (\text{lon} - \text{originLon}) \cdot \frac{\pi}{180} \cdot \cos\left(\text{originLat} \cdot \frac{\pi}{180}\right)$$
  $$z = -R_{\text{WGS84}} \cdot (\text{lat} - \text{originLat}) \cdot \frac{\pi}{180}$$
  where the WGS84 equatorial radius $R_{\text{WGS84}} = 6,378,137.0\text{ m}$.
- **Inverse Projection (`unprojectToGeo`)**:
  $$\text{lon} = \text{originLon} + \frac{x}{R_{\text{WGS84}} \cdot \cos\left(\text{originLat} \cdot \frac{\pi}{180}\right)} \cdot \frac{180}{\pi}$$
  $$\text{lat} = \text{originLat} - \frac{z}{R_{\text{WGS84}}} \cdot \frac{180}{\pi}$$

---

## 2. World-Space Units and Axes

The 3D WebGL world space uses a right-handed Cartesian coordinate system:

- **Unit Scale**: `1 unit = 1.0 meter` (strictly physical metric scale).
- **`+X` Axis**: Points **East**.
- **`+Y` Axis**: Points **Up** (vertical physical elevation above ground).
- **`+Z` Axis**: Points **South**. Consequently, **North** is aligned with `-Z`.

---

## 3. Region Bounds vs. Camera Movement

There is an important architectural distinction between **geometry boundary clipping** and **camera navigation**:

1. **Geometry Boundary Clipping**:
   - Features ingested from GeoJSON or Overpass are clipped against an intentional axis-aligned bounding box `[-clipRadius, +clipRadius]` in meters.
   - This ensures that road ribbons, polygon fills, and building footprints terminate cleanly without ragged jagged edges bleeding indefinitely across the canvas.
2. **Camera Navigation**:
   - The camera is **not** physically locked inside the clip box.
   - Users are free to pan, zoom, and rotate around the framed urban district.
   - Clicking **"Reset / Frame Region"** reframes the orthographic camera to snugly fit the loaded geographic bounding box.

---

## 4. Orthographic Isometric Camera Configuration

The viewer uses an **Orthographic Camera** to provide an architectural isometric projection free of perspective distortion:

- **Default Azimuth Angle**: $45^\circ$ (`DEFAULT_AZIMUTH = Math.PI / 4`).
- **Default Polar Tilt Angle**: $\sim 55.4^\circ$ (`DEFAULT_TILT_ANGLE = Math.PI / 3.25`), providing the classic isometric viewing angle where vertical extrusions and horizontal roads balance visual presence.
- **Default Initial Zoom**: `DEFAULT_INITIAL_ZOOM = 0.85`.
- **Near & Far Frustum Planes (`computeSceneFrustumPlanes`)**:
  - Dynamically calculated from the bounding box dimensions and maximum vertical extrusion heights (`verticalEnvelope`).
  - Guarantees that tall buildings ($24\text{ m}$ to $150\text{ m}$) do not clip against the camera near plane when tilted at steep angles ($72^\circ$).

---

## 5. Projected Bounds Framing Math

When the map loads or when the user clicks **"Frame Region"**, `computeProjectedBoundsFraming()` in `src/scene/CameraController.tsx` fits the loaded region to the screen:

1. **Center Calculation**: Target point $(cx, 0, cz)$ is the center of the 2D bounding box.
2. **Corner Screen Projection**: The 4 ground corners of the bounding box `[minX, minZ]`, `[maxX, minZ]`, `[maxX, maxZ]`, `[minX, maxZ]` are projected into 2D camera-screen coordinates $(u, v)$ taking into account the current azimuth and tilt:
   $$u = (x - cx) \cdot \cos(\text{azimuth}) - (z - cz) \cdot \sin(\text{azimuth})$$
   $$v = ((x - cx) \cdot \sin(\text{azimuth}) + (z - cz) \cdot \cos(\text{azimuth})) \cdot \cos(\text{tilt})$$
3. **Octagonal Inscribed Factor (0.78)**:
   - Square bounding boxes rotated at $45^\circ$ contain large empty diagonal corner spaces.
   - A factor of `0.78` frames the central urban neighborhood tightly on screen rather than letterboxing empty corners.
4. **Aspect Ratio Clamping**:
   - Zoom is calculated as $\min(W / \text{spanU}, H / \text{spanV}) \times \text{paddingFactor}$.
   - Clamped within safe bounds `[0.15, 8.0]`.

---

## 6. User Interaction & Controls

Interactive controls are provided via Drei's `MapControls`:

- **Left-Click / Touch Drag**: Horizontal panning in the camera plane.
- **Right-Click / Two-Finger Drag**: Orbit rotation around view azimuth and vertical pitch/tilt.
- **Scroll Wheel / Pinch**: Continuous orthographic zoom in and out.
- **Rotate Step Buttons**: Incremental $45^\circ$ azimuth rotation steps clockwise or counter-clockwise.
- **Frame Region Button**: Smoothly animates camera position, target, and zoom back to the optimal bounding-box frame.

---

## 7. State Preservation Across UI Changes

- **Theme Swapping**: Switching themes (e.g. from *Tactical* to *Blueprint*) updates material colors and shader properties in-place without resetting camera position, rotation, or zoom.
- **Window Resizing**: Resize listeners update camera frustum planes and aspect ratio without altering the user's active look-at target or orientation.

---

## 8. Numerical & Geographic Limitations

- **Local Tangent Projection Range**: The flat-Earth equirectangular projection assumes a constant meridian radius and cosine factor. For distances $> 25\text{ km}$ from the origin, distortion increases noticeably. The viewer is designed for neighborhood tiles up to $\sim 5\text{ km}$.
- **Orthographic Zoom Bounds**: Very high zoom levels ($> 8.0$) can exhibit sub-centimeter floating point precision limits on WebGL float32 attributes. The controller clamps maximum zoom to $8.0$ and minimum zoom to $0.15$.
