import i18n from "@/i18n";
import { isMobileApp } from "@/lib/core/tauri";
import { isCommercialProviderConfigured } from "@/lib/translate/probe";
import { isCommercialTranslateProvider } from "@/lib/translate/services";
import type { TranslateSettings } from "@/lib/translate/types";

// The mobile shell can also be mounted explicitly in a desktop preview. Its
// executors and shared translation entry points must obey the same policy.
let apiOnlyOwners = 0;

export function enterApiOnlyPdfProcessing(): () => void {
	apiOnlyOwners++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		apiOnlyOwners--;
	};
}

export function isApiOnlyPdfProcessing(explicit = false): boolean {
	return explicit || apiOnlyOwners > 0 || isMobileApp();
}

export function assertApiTranslationSettings(
	settings: Pick<TranslateSettings, "provider" | "providerConfigs">,
	apiOnly = false,
): void {
	assertApiTranslateProvider(settings.provider, apiOnly);
	if (
		isApiOnlyPdfProcessing(apiOnly) &&
		isCommercialTranslateProvider(settings.provider) &&
		!isCommercialProviderConfigured(
			settings.provider,
			settings.providerConfigs[settings.provider],
		)
	) {
		throw new Error(i18n.t("viewer:pdf.apiOnly.translateProviderRequired"));
	}
}

export function assertApiTranslateProvider(
	provider: string,
	apiOnly = false,
): void {
	if (isApiOnlyPdfProcessing(apiOnly) && provider === "agent") {
		throw new Error(i18n.t("viewer:pdf.apiOnly.translateProviderRequired"));
	}
}
