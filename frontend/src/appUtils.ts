import { useEffect, useState } from 'react';
import { api } from './api/client';

export function useApi<T>(path: string, deps: unknown[] = [], enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = () => {
    if (!enabled) {
      setLoading(false);
      setError('');
      return Promise.resolve(data as T | null);
    }
    setLoading(true);
    setError('');
    return api.get<T>(path)
      .then((value) => { setData(value); return value; })
      .catch((err) => { setError(String(err.message || err)); throw err; })
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    let mounted = true;
    if (!enabled) {
      setLoading(false);
      setError('');
      return () => { mounted = false; };
    }
    setLoading(true);
    setError('');
    api.get<T>(path)
      .then((value) => { if (mounted) setData(value); })
      .catch((err) => mounted && setError(String(err.message || err)))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, [...deps, enabled]);
  return { data, error, loading, reload: load };
}

export function localDateTimeValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function toUtc(value?: string) {
  return value ? new Date(value).toISOString() : null;
}

export function numberValue(value: string) {
  return Number(value || 0);
}

export function entityLabel(type: string, id: number, lookup: Record<string, string>) {
  return lookup[`${type}:${id}`] || `${type} #${id}`;
}

export function normalizeSearch(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function matchesSearch(query: string, ...values: unknown[]) {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = normalizeSearch(values.join(' '));
  return terms.every((term) => haystack.includes(term));
}
