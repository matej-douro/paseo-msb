let selectedChildName: string | null = null;

export function rememberedChildName(): string | null {
  return selectedChildName;
}

export function rememberChildName(name: string | null): void {
  selectedChildName = name;
}
