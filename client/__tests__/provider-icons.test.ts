import { findSvgIconProblem } from "@getpaseo/plugin";
import type { PluginIcon } from "@getpaseo/plugin/client";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_ICONS,
  LLM_ICONS,
  PROVIDER_ICONS,
} from "../provider-icons";

function inlineSvg(icon: PluginIcon): string {
  if (typeof icon !== "object" || icon === null || !("svg" in icon)) {
    throw new Error("expected an inline SVG icon");
  }
  return icon.svg;
}

const ICONS = [
  ...Object.entries(PROVIDER_ICONS).map(([name, icon]) => [`provider:${name}`, icon]),
  ...Object.entries(LLM_ICONS).map(([name, icon]) => [`llm:${name}`, icon]),
  ...Object.entries(INTEGRATION_ICONS).map(([name, icon]) => [
    `integration:${name}`,
    icon,
  ]),
] as const;

describe("provider icons", () => {
  it("ships valid self-contained SVGs", () => {
    for (const [name, icon] of ICONS) {
      const problem = findSvgIconProblem(inlineSvg(icon));
      expect(problem, `${name} is a valid icon`).toBeNull();
    }
  });
});
