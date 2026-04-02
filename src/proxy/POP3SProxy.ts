/**
 * POP3SProxy.ts — POP3 proxy with TLS upstream (POP3S / port 995).
 *
 * Mirrors Proxy::POP3S. Identical to POP3Proxy except it defaults to:
 *   - Listening on port 1995 locally (plain TCP from mail client is fine
 *     since it's loopback; TLS to the real server is what matters)
 *   - Connecting to the upstream server with TLS
 *   - Default upstream port 995 when none is specified in the username
 *
 * Username format: user:realserver  or  user:realserver:port
 * (same as POP3Proxy; port defaults to 995 instead of 110)
 *
 * To use, configure your mail client to connect to 127.0.0.1:1995
 * with no encryption (encryption is handled by POPFile → real server).
 */

import { LifecycleResult } from "../core/Module.ts";
import { POP3Proxy } from "./POP3Proxy.ts";

export class POP3SProxy extends POP3Proxy {
  constructor() {
    super();
    this.name_ = "pop3s";
  }

  override initialize(): LifecycleResult {
    super.initialize();
    // Override defaults for TLS upstream
    this.config_("port", "1995");
    this.config_("tls_upstream", "1");
    this.config_("upstream_port", "995");
    this.config_("welcome_string", "POP3S POPFile proxy ready");
    return LifecycleResult.Ok;
  }
}
