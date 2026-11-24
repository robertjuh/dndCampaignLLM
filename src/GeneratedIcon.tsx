import { useEffect, useState, type ReactNode } from 'react';

const requests = new Map<string, Promise<boolean>>();
let queue: Promise<unknown> = Promise.resolve();

export function loadGeneratedImage(url: string) {
  let request = requests.get(url);
  if (!request) {
    // One image request at a time leaves browser connections free for gameplay and events.
    request = queue.then(async () => {
      try {
        const response = await fetch(url, { cache: 'force-cache' });
        await response.arrayBuffer();
        return response.ok;
      } catch {
        return false;
      }
    });
    queue = request;
    requests.set(url, request);
  }
  return request;
}

export function GeneratedIcon({ iconId, fallback, size = 32 }: {
  iconId?: string;
  fallback: ReactNode;
  size?: 32 | 64;
}) {
  const [ready, setReady] = useState<string>();
  useEffect(() => {
    let disposed = false;
    if (iconId)
      void loadGeneratedImage(`/api/icons/${iconId}`).then((ok) => {
        if (ok && !disposed) setReady(iconId);
      });
    return () => {
      disposed = true;
    };
  }, [iconId]);
  return (
    <span className="generated-icon-slot" style={{ width: size, height: size }} aria-hidden="true">
      {ready && ready === iconId ? (
        <img
          className="generated-icon"
          src={`/api/icons/${iconId}`}
          width={size}
          height={size}
          alt=""
          onError={() => setReady(undefined)}
        />
      ) : fallback}
    </span>
  );
}
