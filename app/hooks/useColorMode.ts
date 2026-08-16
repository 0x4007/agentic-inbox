import { useEffect, useState } from "react";

export type ColorMode = "light" | "dark";

const STORAGE_KEY = "agentic-inbox-color-mode";

function systemColorMode(): ColorMode {
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyColorMode(mode: ColorMode) {
	document.documentElement.dataset.mode = mode;
	document.documentElement.style.colorScheme = mode;
}

export function useColorMode() {
	const [colorMode, setColorMode] = useState<ColorMode>("light");

	useEffect(() => {
		const storedMode = window.localStorage.getItem(STORAGE_KEY);
		const mode: ColorMode =
			storedMode === "dark" || storedMode === "light" ? storedMode : systemColorMode();

		applyColorMode(mode);
		setColorMode(mode);
	}, []);

	const toggleColorMode = () => {
		const nextMode: ColorMode = colorMode === "dark" ? "light" : "dark";
		window.localStorage.setItem(STORAGE_KEY, nextMode);
		applyColorMode(nextMode);
		setColorMode(nextMode);
	};

	return { colorMode, toggleColorMode };
}
