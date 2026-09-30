import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Live-harness fault provider.
 *
 * Registers a `faulty` faux provider whose stream always errors, so a child
 * spawned against `faulty/boom` fails at request time. Copied into the
 * isolated agent dir's `extensions/` so both parent and child load it.
 */
export default function faultProvider(pi: ExtensionAPI) {
	const faux = fauxProvider({
		provider: "faulty",
		api: "faulty-api",
		models: [{ id: "boom", name: "Boom", reasoning: false }],
	});
	const error = () =>
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "faulty provider error",
		});
	faux.setResponses([error(), error(), error(), error(), error()]);
	pi.registerProvider(faux.provider);
}
