const PREFIX = "[suppress-providers]";

export function log(message: string, data?: Record<string, unknown>): void {
	if (data && Object.keys(data).length > 0) {
		console.log(PREFIX, message, JSON.stringify(data));
	} else {
		console.log(PREFIX, message);
	}
}
