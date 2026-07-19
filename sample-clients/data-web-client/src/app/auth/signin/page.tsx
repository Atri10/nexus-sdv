'use client';
import { signIn } from 'next-auth/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center">Nexus SDV</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-muted-foreground">Sign in to access the dashboard</p>
          <button
            onClick={() => signIn('keycloak', { callbackUrl: '/fleet' })}
            className="w-full px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Sign in
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
