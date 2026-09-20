import { toNetscape } from "./cookies";

export const COMPANION_CHANNEL = "fathomrail-companion";

export function bookmarkletSource(origin: string): string {
  const src = `(()=>{const o=${JSON.stringify(origin)};const p={type:"simpdl-cookies",host:location.host,href:location.href,cookies:document.cookie};try{const ch=new BroadcastChannel(${JSON.stringify(COMPANION_CHANNEL)});ch.postMessage(p);ch.close();}catch(e){}const w=window.open(o+"/companion","simpdl");setTimeout(()=>{try{w&&w.postMessage(p,o);}catch(e){}},500);})()`;
  return `javascript:${encodeURIComponent(src)}`;
}

export function cookiesFromCompanion(host: string, cookieHeader: string): string {
  const pairs = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf("=");
      return { domain: host, path: "/", name: eq === -1 ? p : p.slice(0, eq), value: eq === -1 ? "" : p.slice(eq + 1) };
    })
    .filter((c) => c.name);
  return toNetscape(pairs);
}
