import React, { useState, useEffect, useRef } from 'react';
import { Search, MapPin, Loader2, X, Download, Sliders, Globe, ArrowRight } from 'lucide-react';

export interface GeocodeResult {
  name: string;
  displayName: string;
  lat: number;
  lon: number;
  type: string;
}

export interface AddressSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectLocation: (location: GeocodeResult, radiusMeters: number) => Promise<void>;
  currentGeoJson?: any;
}

const POPULAR_LANDMARKS: { label: string; query: string }[] = [
  { label: 'Colosseum, Rome', query: 'Colosseum, Rome' },
  { label: 'Tower Bridge, London', query: 'Tower Bridge, London' },
  { label: 'Brandenburg Gate, Berlin', query: 'Brandenburg Gate, Berlin' },
  { label: 'Sydney Opera House', query: 'Sydney Opera House' },
  { label: 'Eiffel Tower, Paris', query: 'Eiffel Tower, Paris' },
  { label: 'Empire State Building', query: 'Empire State Building, New York' },
];

export const AddressSearchModal: React.FC<AddressSearchModalProps> = ({
  isOpen,
  onClose,
  onSelectLocation,
  currentGeoJson,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingMap, setLoadingMap] = useState(false);
  const [radius, setRadius] = useState(380); // meters (~0.75 km2 box)
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const debounceTimeout = useRef<NodeJS.Timeout | null>(null);

  // Debounced geocode search
  useEffect(() => {
    if (!query || query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);

    debounceTimeout.current = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query.trim())}`);
        if (!res.ok) throw new Error('Geocoding request failed');
        const data = await res.json();
        setResults(data);
      } catch (err: any) {
        console.error('Search error:', err);
        setError(err.message);
      } finally {
        setSearching(false);
      }
    }, 350);

    return () => {
      if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    };
  }, [query]);

  const handleSelect = async (loc: GeocodeResult) => {
    setLoadingMap(true);
    setError(null);
    setStatusMessage(`Fetching OpenStreetMap features for ${loc.name}...`);
    try {
      await onSelectLocation(loc, radius);
      onClose();
    } catch (err: any) {
      console.error('Failed to load location:', err);
      setError(err.message);
    } finally {
      setLoadingMap(false);
      setStatusMessage('');
    }
  };

  const handleDownloadGeoJson = () => {
    if (!currentGeoJson) return;
    const blob = new Blob([JSON.stringify(currentGeoJson, null, 2)], {
      type: 'application/geo+json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(currentGeoJson.name || 'map-region').toLowerCase().replace(/[^a-z0-9]/g, '-')}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in">
      <div className="relative w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <Globe className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Search Address or Landmark</h2>
              <p className="text-xs text-slate-400">
                Retrieve real-world 3D OpenStreetMap GeoJSON for any location
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Input */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter an address, landmark, or city (e.g. Colosseum, Rome)..."
              autoFocus
              className="w-full pl-10 pr-10 py-2.5 bg-slate-800/80 border border-slate-700/80 rounded-xl text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/50 transition"
            />
            {searching && (
              <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-cyan-400 animate-spin" />
            )}
            {query && !searching && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Area Radius Slider */}
          <div className="bg-slate-800/40 border border-slate-800 p-3 rounded-xl flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <Sliders className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>Capture Extent:</span>
              <span className="font-mono font-bold text-cyan-300">{radius * 2}m × {radius * 2}m</span>
              <span className="text-slate-500 text-[11px]">({((radius * 2 * radius * 2) / 1000000).toFixed(2)} km²)</span>
            </div>
            <input
              type="range"
              min="250"
              max="5000"
              step="250"
              value={radius}
              onChange={(e) => setRadius(parseInt(e.target.value, 10))}
              className="w-36 accent-cyan-400 cursor-pointer"
            />
          </div>

          {/* Popular Suggestions */}
          {!query && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block mb-2">
                Popular Real-World Destinations
              </span>
              <div className="flex flex-wrap gap-2">
                {POPULAR_LANDMARKS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setQuery(item.query);
                    }}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700/80 border border-slate-700/60 rounded-lg text-xs text-slate-300 transition flex items-center gap-1.5 cursor-pointer"
                  >
                    <MapPin className="w-3.5 h-3.5 text-cyan-400" />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Search Results List */}
          {results.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">
                Matching Addresses
              </span>
              <div className="space-y-1">
                {results.map((loc, idx) => (
                  <button
                    key={`${loc.lat}-${loc.lon}-${idx}`}
                    type="button"
                    disabled={loadingMap}
                    onClick={() => handleSelect(loc)}
                    className="w-full text-left p-3 bg-slate-800/60 hover:bg-slate-800 border border-slate-700/40 hover:border-cyan-500/40 rounded-xl transition flex items-center justify-between group cursor-pointer"
                  >
                    <div className="flex items-start gap-2.5 pr-2">
                      <MapPin className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
                      <div>
                        <div className="text-xs font-bold text-slate-100 group-hover:text-cyan-300 transition">
                          {loc.name}
                        </div>
                        <div className="text-[11px] text-slate-400 line-clamp-1">
                          {loc.displayName}
                        </div>
                      </div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-slate-500 group-hover:text-cyan-400 group-hover:translate-x-0.5 transition shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {query && !searching && results.length === 0 && (
            <div className="text-center py-6 text-xs text-slate-400">
              No places found for &quot;{query}&quot;. Try adding a city or country.
            </div>
          )}

          {/* Loading status */}
          {loadingMap && (
            <div className="p-4 bg-cyan-950/40 border border-cyan-800/40 rounded-xl flex items-center gap-3 text-xs text-cyan-300">
              <Loader2 className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />
              <span>{statusMessage || 'Loading OpenStreetMap data and generating 3D geometry...'}</span>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-950/40 border border-red-800/40 rounded-xl text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        {/* Footer / GeoJSON Download Action */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-800 bg-slate-900/80">
          <span className="text-[11px] text-slate-400">
            Data sourced dynamically from OpenStreetMap
          </span>
          {currentGeoJson && (
            <button
              type="button"
              onClick={handleDownloadGeoJson}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-cyan-400" />
              <span>Export Current GeoJSON</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
