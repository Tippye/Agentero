import { createStore } from "zustand/vanilla";

export type FigureLightboxRequest = {
	src: string;
	title: string;
};

type State = { request: FigureLightboxRequest | null };

/** One process-wide image lightbox; the mobile shell owns Android Back. */
export const figureLightboxStore = createStore<State>(() => ({
	request: null,
}));

export function openFigureLightbox(request: FigureLightboxRequest): void {
	figureLightboxStore.setState({ request });
}

export function closeFigureLightbox(): void {
	figureLightboxStore.setState({ request: null });
}
