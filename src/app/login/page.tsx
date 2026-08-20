import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { getSession } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await getSession()) redirect('/');
  const { next } = await searchParams;
  return <LoginForm next={next} />;
}
