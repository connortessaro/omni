import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "../storage";
import { STORAGE_KEYS } from "@/config";

// Helper function to check if Omni Cloud API should be used
export async function shouldUseOmniAPI(): Promise<boolean> {
  try {
    const omniApiEnabled =
      safeLocalStorage.getItem(STORAGE_KEYS.OMNI_API_ENABLED) === "true" ||
      safeLocalStorage.getItem(STORAGE_KEYS.PLUELY_API_ENABLED) === "true";
    if (!omniApiEnabled) return false;

    // Check if license is available
    const hasLicense = await invoke<boolean>("check_license_status");
    return hasLicense;
  } catch (error) {
    console.warn("Failed to check Omni API availability:", error);
    return false;
  }
}

// Backward-compatible alias
export const shouldUsePluelyAPI = shouldUseOmniAPI;
