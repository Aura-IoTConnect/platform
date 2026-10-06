// Secret-fingerprint omission shared by every route that returns a Device or
// DeviceType. Prisma `include` hands back every scalar column, so any route
// that nests a Device/DeviceType in its response must pass it through here —
// apiKeyHash and provisionSecretHash are credential fingerprints and must
// never reach a client, even an authenticated one. (A leak through nested
// includes was found once in devices.ts, then again in alerts, rules,
// watchlist and verticals — hence one shared, tested place for it.)

export function omitApiKeyHash<T extends { apiKeyHash: string | null }>(device: T): Omit<T, "apiKeyHash"> {
  const { apiKeyHash: _apiKeyHash, ...rest } = device;
  return rest;
}

export function omitProvisionSecretHash<T extends { provisionSecretHash: string | null }>(
  deviceType: T,
): Omit<T, "provisionSecretHash"> {
  const { provisionSecretHash: _provisionSecretHash, ...rest } = deviceType;
  return rest;
}

// For a Device that was loaded with `include: { deviceType: ... }`.
export function omitNestedProvisionSecretHash<T extends { deviceType: { provisionSecretHash: string | null } }>(
  device: T,
): T & { deviceType: Omit<T["deviceType"], "provisionSecretHash"> } {
  return { ...device, deviceType: omitProvisionSecretHash(device.deviceType) } as T & {
    deviceType: Omit<T["deviceType"], "provisionSecretHash">;
  };
}

// Device + its nested deviceType, both stripped.
export function omitDeviceSecrets<
  T extends { apiKeyHash: string | null; deviceType: { provisionSecretHash: string | null } },
>(device: T) {
  return omitNestedProvisionSecretHash(omitApiKeyHash(device));
}
