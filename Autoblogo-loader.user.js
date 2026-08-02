// ==UserScript==
// @name         Autoblogo - loader
// @namespace    https://github.com/ShadoxDDL/autoblogo
// @version      1.0.2
// @description  Ładuje Autoblogo z własnej kopii na GitHub Pages.
// @match        https://*.margonem.pl/*
// @exclude      https://www.margonem.pl/*
// @match        https://*.margonem.com/*
// @exclude      https://www.margonem.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";
  const SCRIPT_URL = "https://shadoxddl.github.io/autoblogo/Autoblogo.js?v=3";
  const scripts = window.GARGONEM_PLUGINS ?? (window.GARGONEM_PLUGINS = []);
  scripts.push(SCRIPT_URL);
})();
