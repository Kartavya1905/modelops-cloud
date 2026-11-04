import { Injectable, type OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';

/** OWASP minimum recommendation for Argon2id: 19 MiB memory, 2 iterations, 1 lane. */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  /** Verified against when the email is unknown, so "no such user" takes as long as "wrong password". */
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash('modelops-timing-equaliser', OPTIONS);
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  async verify(hash: string | null, password: string): Promise<boolean> {
    try {
      const ok = await argon2.verify(hash ?? this.dummyHash, password);
      return hash !== null && ok;
    } catch {
      return false;
    }
  }
}
