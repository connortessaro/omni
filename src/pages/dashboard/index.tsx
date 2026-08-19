import { useNavigate } from "react-router-dom";
import { Button, Card } from "@/components";
import { PageLayout } from "@/layouts";
import { useApp } from "@/contexts";
import { CheckCircle2, Code, AlertCircle } from "lucide-react";

const Dashboard = () => {
  const navigate = useNavigate();
  const { selectedAIProvider, selectedSttProvider, allAiProviders, allSttProviders } =
    useApp();

  const aiProvider = allAiProviders.find(
    (p) => p.id === selectedAIProvider.provider
  );
  const sttProvider = allSttProviders.find(
    (p) => p.id === selectedSttProvider.provider
  );

  const rows = [
    { label: "AI provider", value: aiProvider?.id },
    { label: "Speech provider", value: sttProvider?.id },
  ];

  return (
    <PageLayout
      title="Dashboard"
      description="Omni runs on your own provider keys. Nothing leaves this machine except the requests you make."
    >
      <Card className="shadow-none p-4 border border-border/70 rounded-xl space-y-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3">
            {row.value ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <AlertCircle className="size-4 text-muted-foreground" />
            )}
            <p className="flex-1 text-xs lg:text-sm font-medium">{row.label}</p>
            <code className="px-3 py-1.5 bg-muted rounded text-xs lg:text-sm font-mono">
              {row.value ?? "not configured"}
            </code>
          </div>
        ))}
      </Card>

      <Button
        variant="outline"
        className="w-fit"
        onClick={() => navigate("/dev-space")}
      >
        <Code className="h-4 w-4" /> Configure providers
      </Button>
    </PageLayout>
  );
};

export default Dashboard;
