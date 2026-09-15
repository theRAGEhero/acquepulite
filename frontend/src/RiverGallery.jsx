import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "./telemetry.js";

const SORT_OPTIONS = [
  { value: "name", label: "Name A–Z" },
  { value: "region", label: "Region" },
  { value: "length", label: "Length" },
  { value: "status", label: "WFD status" }
];

const STATUS_ORDER = { high: 0, good: 1, moderate: 2, poor: 3, bad: 4 };

function RiverCard({ river, regionName, onOpen }) {
  const [image, setImage] = useState(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);
  const cardRef = useRef(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (requestedRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      requestedRef.current = true;
      observer.disconnect();
      const controller = new AbortController();
      apiFetch(`/api/rivers/${river.id}/image`, { signal: controller.signal })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
          if (data?.available && data.thumb_url) setImage(data);
          else setImageFailed(true);
          setImageLoading(false);
        })
        .catch(error => {
          if (error.name === "AbortError") return;
          setImageFailed(true);
          setImageLoading(false);
        });
    }, { rootMargin: "300px" });
    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [river.id]);

  const statusLabel = river.wfd_status
    ? river.wfd_status.charAt(0).toUpperCase() + river.wfd_status.slice(1)
    : null;

  return (
    <li className="river-card" ref={cardRef}>
      <button className="river-card-main" onClick={() => onOpen(river)}
        aria-label={`Show documents for ${river.name}`} title={`Show documents for ${river.name}`}>
        <div className={`river-card-image ${imageLoading ? "loading" : ""}`}>
          {image?.thumb_url && !imageFailed ? (
            <img src={image.thumb_url} alt={river.name} loading="lazy"
              onError={() => setImageFailed(true)} />
          ) : (
            <span className="river-card-placeholder">
              {imageFailed ? "No image yet" : "…"}
            </span>
          )}
          {image?.license && !imageFailed && (
            <span className="river-card-license" title={`License: ${image.license}`}>
              {image.license}
            </span>
          )}
        </div>
        <div className="river-card-body">
          <h3>{river.name}</h3>
          <p className="river-card-region">{regionName || river.region || "Italy"}</p>
          <div className="river-card-stats">
            {river.length_km ? <span>{river.length_km} km</span> : null}
            {statusLabel && (
              <span className={`river-card-status ${river.wfd_status}`}>{statusLabel}</span>
            )}
            {river.has_data && <span className="river-card-data">Monitored</span>}
          </div>
          <span className="river-card-docs">Documents →</span>
        </div>
      </button>
    </li>
  );
}

export default function RiverGallery({ rivers, regions, onOpenRiver }) {
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState("");
  const [sort, setSort] = useState("name");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const regionNames = useMemo(() => {
    const map = new Map(regions.map(item => [item.code, item.name]));
    return map;
  }, [regions]);

  const visibleRivers = useMemo(() => {
    const needle = debouncedQuery.toLocaleLowerCase("it");
    const filtered = rivers.filter(river => {
      if (needle && !String(river.name).toLocaleLowerCase("it").includes(needle)) return false;
      if (region && !(river.region_codes || []).includes(region)) return false;
      return true;
    });
    const collator = new Intl.Collator("it", { sensitivity: "base" });
    return filtered.sort((a, b) => {
      if (sort === "name") return collator.compare(a.name, b.name);
      if (sort === "region") {
        const regionCompare = collator.compare(regionNames.get(a.region_code) || "", regionNames.get(b.region_code) || "");
        return regionCompare || collator.compare(a.name, b.name);
      }
      if (sort === "length") return (b.length_km || 0) - (a.length_km || 0);
      if (sort === "status") {
        const statusCompare = (STATUS_ORDER[a.wfd_status] ?? 9) - (STATUS_ORDER[b.wfd_status] ?? 9);
        return statusCompare || collator.compare(a.name, b.name);
      }
      return 0;
    });
  }, [rivers, debouncedQuery, region, sort, regionNames]);

  return (
    <section className="river-gallery" aria-label="River gallery">
      <header className="river-gallery-header">
        <div>
          <h2>Rivers</h2>
          <p>Every river in the system, with a real photo where Wikimedia Commons has one. Click a card to see its documents.</p>
        </div>
        <div className="river-gallery-controls">
          <input type="search" value={query} placeholder="Search river…"
            onChange={event => setQuery(event.target.value)} aria-label="Search rivers" />
          <select value={region} onChange={event => setRegion(event.target.value)} aria-label="Filter by region">
            <option value="">All regions</option>
            {regions.map(item => (
              <option key={item.code} value={item.code}>{item.name}</option>
            ))}
          </select>
          <select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort rivers">
            {SORT_OPTIONS.map(item => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </div>
      </header>

      <div className="river-gallery-count">
        {visibleRivers.length} river{visibleRivers.length === 1 ? "" : "s"}
      </div>

      {visibleRivers.length === 0 ? (
        <div className="river-gallery-empty">
          <h3>No rivers match these filters</h3>
          <p>Try a different search or clear the region filter.</p>
        </div>
      ) : (
        <ul className="river-card-grid">
          {visibleRivers.map(river => (
            <RiverCard key={river.id} river={river}
              regionName={regionNames.get(river.region_code)}
              onOpen={onOpenRiver} />
          ))}
        </ul>
      )}
    </section>
  );
}
