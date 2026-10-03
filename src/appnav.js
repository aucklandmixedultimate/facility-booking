// The two apps on this site and the switcher between them, shared by the booking site
// (React, src/booking-system.jsx) and the Council fields page (vanilla, src/vetting/main.js).
// Both render the same markup and classes (src/appnav.css); links stay in the same tab.

import "./appnav.css";

export const APPS = [
  { id: "bookings", icon: "📅", label: "Bookings",       path: "",             title: "Facility bookings: calendar, requests, billing" },
  { id: "fields",   icon: "🗺", label: "Council fields", path: "vetting.html", title: "Council / Community fields: rate parks, add fields to book" },
];

export const appHref = (app, base = import.meta.env.BASE_URL) => base + app.path;

// Vanilla: fills `el` with the switcher, `current` being an APPS id.
export function renderAppNav(el, current, base) {
  el.className = "appnav"; el.setAttribute("aria-label", "Apps");
  el.replaceChildren(...APPS.map(a => {
    const link = document.createElement("a");
    link.href = appHref(a, base); link.title = a.title;
    if (a.id === current) link.setAttribute("aria-current", "page");
    link.innerHTML = `<span class="ai" aria-hidden="true">${a.icon}</span><span class="al">${a.label}</span>`;
    return link;
  }));
}
