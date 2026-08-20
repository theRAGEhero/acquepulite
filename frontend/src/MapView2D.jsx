import MapView3D from "./MapView3D.jsx";

// Both views use the same MapLibre vector hydrography. Switching views changes
// only the camera, never the river geometry.
export default function MapView2D(props) {
  return <MapView3D {...props} flat />;
}
