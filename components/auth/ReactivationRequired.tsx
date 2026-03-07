/**
 * ReactivationRequired — Shown when vault recovery hits a 402 (archived vault).
 *
 * Displays a friendly message explaining that the vault is archived and
 * directs the user to upgrade to Premium via LemonSqueezy to restore access.
 */

import React from 'react';
import { Lock, ExternalLink, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Layout, Header, ScrollableBody, Footer } from '@/components/shared/Layout';

interface ReactivationRequiredProps {
  reactivateUrl: string;
  archivedSince: string;
  onBack: () => void;
}

export function ReactivationRequired({
  reactivateUrl,
  archivedSince,
  onBack,
}: ReactivationRequiredProps) {
  // Format the archived date for display
  const archivedDate = archivedSince
    ? new Date(archivedSince).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      })
    : 'an extended period';

  const handleUpgrade = () => {
    // Open LemonSqueezy checkout in a new tab
    chrome.tabs.create({ url: reactivateUrl });
  };

  return (
    <Layout>
      <Header
        title="Vault Archived"
        left={
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="h-6 w-6 p-0"
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />
      <ScrollableBody className="p-4 space-y-4">
        <div className="w-full flex justify-center">
          <div className="w-14 h-14 rounded-2xl bg-amber-500/10 flex items-center justify-center">
            <Lock className="w-7 h-7 text-amber-500" />
          </div>
        </div>

        <div className="space-y-2 text-center">
          <h2 className="text-sm font-semibold">Vault Archived</h2>
          <p className="text-xs text-muted-foreground">
            Your vault has been inactive since {archivedDate} and is archived.
          </p>
        </div>

        <div className="bg-muted rounded-lg px-4 py-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Your data is still safe &mdash; your vault is encrypted and waiting.
            Upgrade to Premium to restore access and enjoy all premium features.
          </p>
          <p className="text-xs text-muted-foreground">
            After restoring, you can downgrade to Free at any time.
          </p>
        </div>
      </ScrollableBody>

      <Footer>
        <Button
          onClick={handleUpgrade}
          className="w-full gap-2"
        >
          <ExternalLink className="w-4 h-4" />
          Upgrade to Premium
        </Button>
      </Footer>
    </Layout>
  );
}
