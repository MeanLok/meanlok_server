import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { createPublicKey } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';

type SupabaseJwtPayload = {
  sub?: string;
  email?: string;
  user_metadata?: {
    name?: string;
    full_name?: string;
  };
};

type JwtHeader = {
  alg?: string;
  kid?: string;
};

type SupabaseJwk = {
  kid?: string;
  [key: string]: unknown;
};

type SupabaseJwksResponse = {
  keys: SupabaseJwk[];
};

type JwksCache = {
  payload: SupabaseJwksResponse | null;
  loadedAt: number;
};

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

function parseJwtHeader(rawJwtToken: string): JwtHeader {
  const [headerSegment] = rawJwtToken.split('.');

  if (!headerSegment) {
    throw new UnauthorizedException('Invalid token format');
  }

  try {
    const decodedHeader = Buffer.from(headerSegment, 'base64url').toString('utf8');
    return JSON.parse(decodedHeader) as JwtHeader;
  } catch {
    throw new UnauthorizedException('Invalid token header');
  }
}

async function fetchJwks(supabaseUrl: string, cache: JwksCache) {
  if (
    cache.payload &&
    Date.now() - cache.loadedAt < JWKS_CACHE_TTL_MS
  ) {
    return cache.payload;
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
  if (!response.ok) {
    throw new UnauthorizedException('Failed to fetch Supabase JWKS');
  }

  const jwks = (await response.json()) as SupabaseJwksResponse;
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new UnauthorizedException('Supabase JWKS is empty');
  }

  cache.payload = jwks;
  cache.loadedAt = Date.now();
  return jwks;
}

async function resolveSigningKey({
  rawJwtToken,
  sharedSecret,
  supabaseUrl,
  jwksCache,
  allowHs256,
}: {
  rawJwtToken: string;
  sharedSecret?: string;
  supabaseUrl: string;
  jwksCache: JwksCache;
  allowHs256: boolean;
}) {
  const { alg, kid } = parseJwtHeader(rawJwtToken);

  if (alg === 'HS256') {
    if (!allowHs256) {
      throw new UnauthorizedException('HS256 tokens are not allowed');
    }

    if (!sharedSecret) {
      throw new UnauthorizedException(
        'SUPABASE_JWT_SECRET is required for HS256 tokens',
      );
    }

    return sharedSecret;
  }

  if (alg !== 'ES256') {
    throw new UnauthorizedException(
      `Unsupported JWT algorithm: ${alg ?? 'unknown'}`,
    );
  }

  if (!kid) {
    throw new UnauthorizedException('JWT kid is missing');
  }

  const { keys } = await fetchJwks(supabaseUrl, jwksCache);
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) {
    throw new UnauthorizedException('No matching signing key in Supabase JWKS');
  }

  const publicKey = createPublicKey({
    key: jwk as any,
    format: 'jwk',
  });

  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const supabaseUrl = configService
      .get<string>('SUPABASE_URL')
      ?.trim()
      .replace(/\/$/, '');

    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL is not configured');
    }

    const sharedSecret = configService.get<string>('SUPABASE_JWT_SECRET')?.trim();
    const allowHs256 = process.env.NODE_ENV !== 'production';
    const algorithms: Array<'ES256' | 'HS256'> = ['ES256'];
    if (allowHs256) {
      algorithms.push('HS256');
    }

    const jwksCache: JwksCache = {
      payload: null,
      loadedAt: 0,
    };

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      issuer: `${supabaseUrl}/auth/v1`,
      audience: 'authenticated',
      algorithms,
      secretOrKeyProvider: (_request, rawJwtToken, done) => {
        resolveSigningKey({
          rawJwtToken,
          sharedSecret,
          supabaseUrl,
          jwksCache,
          allowHs256,
        })
          .then((signingKey) => done(null, signingKey))
          .catch((error) => done(error as Error));
      },
    });
  }

  async validate(payload: SupabaseJwtPayload) {
    const id = payload.sub;

    if (!id) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const normalizedEmail = payload.email?.trim().toLowerCase();
    const rawName = payload.user_metadata?.name ?? payload.user_metadata?.full_name;
    const normalizedName = rawName?.trim();
    const resolvedEmail =
      normalizedEmail && normalizedEmail.length > 0
        ? normalizedEmail
        : `${id}@users.meanlok.local`;
    const resolvedName =
      normalizedName && normalizedName.length > 0
        ? normalizedName
        : resolvedEmail.split('@')[0] || 'user';

    const profile = await this.prisma.profile.upsert({
      where: { id },
      update: {
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(normalizedName ? { name: normalizedName } : {}),
      },
      create: {
        id,
        email: resolvedEmail,
        name: resolvedName,
      },
    });

    return profile;
  }
}
