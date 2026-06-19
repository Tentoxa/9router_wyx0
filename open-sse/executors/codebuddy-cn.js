import { DefaultExecutor } from "./default.js";

export class CodeBuddyCnExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const effort = transformed.reasoning_effort;
    if (effort === "none" || effort === "off") {
      delete transformed.reasoning_effort;
    } else {
      if (!effort) transformed.reasoning_effort = "medium";
      transformed.reasoning_summary = "auto";
    }

    return transformed;
  }
}

export default CodeBuddyCnExecutor;
