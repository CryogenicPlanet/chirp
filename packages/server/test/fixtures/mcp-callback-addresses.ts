import { makeAddressPolicy } from "../../../../examples/extensions/mcp/addresses.ts";

/** The MCP example's callback address policy, exercised without installing the extension. */
export const publicCallbackAddress = (address: string) => makeAddressPolicy()(address);
