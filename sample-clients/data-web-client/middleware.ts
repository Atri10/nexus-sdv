import { NextResponse, type NextRequest } from 'next/server';
import { withAuth } from 'next-auth/middleware';

// /fleet and /device are gated behind NextAuth in production. The local
// demo stack (DEMO_MODE=true) bypasses the login entirely — NextAuth 4 is
// incompatible with this repo's Next.js 16 runtime, so demo mode must not
// depend on it. The middleware still runs the session check when
// DEMO_MODE is unset (production).
export default withAuth(
  function middleware(req: NextRequest) {
    return NextResponse.next();
  },
  {
    callbacks: {
      // Demo mode bypasses login; production requires a valid session token.
      authorized: ({ token }) => process.env.DEMO_MODE === 'true' || Boolean(token),
    },
  }
);

export const config = {
  matcher: ['/fleet/:path*', '/device/:path*'],
};
