import React, { useEffect, useRef, useState } from "react";
import { gamesTabs, gamesTabUrl } from "./review_route.js";

const sections = [
  { page: "study", label: "Study", href: "#", shortcuts: [{ page: "saved-reviews", label: "Saved for review" }] },
  { page: "games", label: "Games", href: gamesTabUrl("library"),
    shortcuts: gamesTabs.map(([tab, label]) => ({ page: "games", label, href: gamesTabUrl(tab) })) },
  { page: "repertoires", label: "Repertoires" },
  { page: "tactics", label: "Tactics", shortcuts: [
    { page: "capture", label: "Capture tactics" },
    { page: "tactic-settings", label: "Tactics settings" },
  ] },
];

function Destination({ item, active, current, disabled, onSelect }) {
  const props = {
    className: "tempo-nav-action",
    "data-active": active || undefined,
    "aria-current": current ? "page" : undefined,
    onClick: event => onSelect(event, item),
  };
  if (item.href) return <a {...props} href={disabled ? undefined : item.href}
    role={disabled ? "link" : undefined} aria-disabled={disabled || undefined}>{item.label}</a>;
  return <button {...props} type="button" disabled={disabled}>{item.label}</button>;
}

export function DesktopNavigation({ page, onNavigate, navigationLocked }) {
  const [menu, setMenu] = useState(null);
  const openMenu = menu?.id;
  const nav = useRef(null);
  const triggers = useRef({});

  useEffect(() => {
    if (!openMenu) return;
    function dismissOutside(event) {
      if (!nav.current?.contains(event.target)) setMenu(null);
    }
    function dismissOnEscape(event) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (nav.current?.contains(document.activeElement)) {
        triggers.current[openMenu]?.focus({ preventScroll: true });
        event.preventDefault();
      }
      setMenu(null);
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [openMenu]);

  function closeMenu(id) {
    setMenu(current => current?.id === id ? null : current);
  }

  function closeOnBlur(event, menu) {
    if (!event.currentTarget.contains(event.relatedTarget)) closeMenu(menu);
  }

  function select(event, item) {
    if (navigationLocked(item.page)) {
      event.preventDefault();
      return;
    }
    if (item.href && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    event.preventDefault();
    if (onNavigate(item.page, item.href)) {
      if (event.currentTarget.closest(".tempo-nav-popover")) triggers.current[openMenu]?.focus({ preventScroll: true });
      setMenu(null);
    }
  }

  function disclosure(id, label, name) {
    return <button type="button" className="tempo-nav-toggle" ref={node => { triggers.current[id] = node; }}
      aria-label={name} aria-expanded={openMenu === id} aria-controls={`tempo-nav-${id}`}
      onClick={() => setMenu(current => current?.id === id && !current.hover ? null : { id, hover: false })}>
      {label}<span aria-hidden="true" className="tempo-nav-chevron" />
    </button>;
  }

  function destination(item, current, active = current) {
    return <Destination item={item} current={current} active={active}
      disabled={navigationLocked(item.page)} onSelect={select} />;
  }

  return <nav className="tempo-core tempo-nav" aria-label="Tempo sections" ref={nav}>
    <span className="tempo-nav-brand">Tempo</span>
    <div className="tempo-nav-sections">
      {sections.map(section => {
        const menu = section.page;
        const current = page === menu;
        const active = current || section.shortcuts?.some(item => item.page === page);
        return <div className="tempo-nav-group" key={menu} data-active={active || undefined}
          onPointerEnter={event => {
            if (event.pointerType !== "mouse") return;
            if (!section.shortcuts) setMenu(null);
            else setMenu(current => current?.id === menu ? current : { id: menu, hover: true });
          }}
          onPointerLeave={event => {
            if (event.pointerType === "mouse" && !event.currentTarget.contains(document.activeElement)) {
              setMenu(current => current?.id === menu && current.hover ? null : current);
            }
          }}
          onBlur={event => closeOnBlur(event, menu)}>
          {destination(section, current, active)}
          {section.shortcuts && <>
            {disclosure(menu, null, `${section.label} shortcuts`)}
            <ul className="tempo-nav-popover" id={`tempo-nav-${menu}`} hidden={openMenu !== menu}>
              {section.shortcuts.map(item => <li key={item.href ?? item.page}>
                {destination(item, !item.href && page === item.page)}
              </li>)}
            </ul>
          </>}
        </div>;
      })}
    </div>
    <div className="tempo-nav-compact" onBlur={event => closeOnBlur(event, "all")}>
      {disclosure("all", "Menu")}
      <ul className="tempo-nav-popover" id="tempo-nav-all" hidden={openMenu !== "all"}>
        {sections.map(section => <li key={section.page}>
          {destination(section, page === section.page)}
          {section.shortcuts && <ul>{section.shortcuts.map(item => <li key={item.href ?? item.page}>
            {destination(item, !item.href && page === item.page)}
          </li>)}</ul>}
        </li>)}
      </ul>
    </div>
  </nav>;
}
