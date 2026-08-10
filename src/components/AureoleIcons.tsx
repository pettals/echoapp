import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import {
  AlertCircle as AlertCircleIcon,
  AppWindow as AppWindowIcon,
  ArrowRight as ArrowRightIcon,
  AudioWaveform as AudioWaveformIcon,
  Check as CheckIcon,
  CheckCircle2 as CheckCircle2Icon,
  ChevronDown as ChevronDownIcon,
  CircleDot as CircleDotIcon,
  Cloud as CloudIcon,
  Command as CommandIcon,
  Copy as CopyIcon,
  Cpu as CpuIcon,
  CreditCard as CreditCardIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  FileText as FileTextIcon,
  Flame as FlameIcon,
  Gauge as GaugeIcon,
  Globe2 as GlobeIcon,
  History as HistoryIcon,
  Home as HomeIcon,
  Info as InfoIcon,
  Keyboard as KeyboardIcon,
  KeyRound as KeyRoundIcon,
  Link as LinkIcon,
  Lock as LockIcon,
  LogIn as LogInIcon,
  LogOut as LogOutIcon,
  Mail as MailIcon,
  MessageSquare as MessageIcon,
  Mic as MicIcon,
  Monitor as MonitorIcon,
  Moon as MoonIcon,
  PartyPopper as PartyPopperIcon,
  Plus as PlusIcon,
  Power as PowerIcon,
  RefreshCw as RefreshCwIcon,
  Save as SaveIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Share2 as ShareIcon,
  Shield as ShieldIcon,
  Sparkles as SparklesIcon,
  Square as SquareIcon,
  Sun as SunIcon,
  Target as TargetIcon,
  Trash2 as Trash2Icon,
  Trophy as TrophyIcon,
  User as UserIcon,
  Users as UsersIcon,
  Volume2 as Volume2Icon,
  X as XIcon,
} from "lucide-react";

function echoIcon(Icon: ComponentType<LucideProps>) {
  function EchoIcon({ strokeWidth = 1.75, ...props }: LucideProps) {
    return <Icon strokeWidth={strokeWidth} {...props} />;
  }

  return EchoIcon;
}

export const AlertCircle = echoIcon(AlertCircleIcon);
export const AppWindow = echoIcon(AppWindowIcon);
export const ArrowRight = echoIcon(ArrowRightIcon);
export const AudioWaveform = echoIcon(AudioWaveformIcon);
export const Check = echoIcon(CheckIcon);
export const CheckCircle2 = echoIcon(CheckCircle2Icon);
export const ChevronDown = echoIcon(ChevronDownIcon);
export const CircleDot = echoIcon(CircleDotIcon);
export const Cloud = echoIcon(CloudIcon);
export const Command = echoIcon(CommandIcon);
export const Copy = echoIcon(CopyIcon);
export const Cpu = echoIcon(CpuIcon);
export const CreditCard = echoIcon(CreditCardIcon);
export const Eye = echoIcon(EyeIcon);
export const EyeOff = echoIcon(EyeOffIcon);
export const FileText = echoIcon(FileTextIcon);
export const Flame = echoIcon(FlameIcon);
export const Gauge = echoIcon(GaugeIcon);
export const Globe = echoIcon(GlobeIcon);
export const History = echoIcon(HistoryIcon);
export const Home = echoIcon(HomeIcon);
export const Info = echoIcon(InfoIcon);
export const Keyboard = echoIcon(KeyboardIcon);
export const KeyRound = echoIcon(KeyRoundIcon);
export const Link = echoIcon(LinkIcon);
export const Lock = echoIcon(LockIcon);
export const LogIn = echoIcon(LogInIcon);
export const LogOut = echoIcon(LogOutIcon);
export const Mail = echoIcon(MailIcon);
export const Message = echoIcon(MessageIcon);
export const Mic = echoIcon(MicIcon);
export const Monitor = echoIcon(MonitorIcon);
export const Moon = echoIcon(MoonIcon);
export const PartyPopper = echoIcon(PartyPopperIcon);
export const Plus = echoIcon(PlusIcon);
export const Power = echoIcon(PowerIcon);
export const Profile = echoIcon(UserIcon);
export const RefreshCw = echoIcon(RefreshCwIcon);
export const Save = echoIcon(SaveIcon);
export const Search = echoIcon(SearchIcon);
export const Settings = echoIcon(SettingsIcon);
export const Share = echoIcon(ShareIcon);
export const Shield = echoIcon(ShieldIcon);
export const Sparkles = echoIcon(SparklesIcon);
export const Square = echoIcon(SquareIcon);
export const Sun = echoIcon(SunIcon);
export const Target = echoIcon(TargetIcon);
export const Trash2 = echoIcon(Trash2Icon);
export const Trophy = echoIcon(TrophyIcon);
export const User = echoIcon(UserIcon);
export const Users = echoIcon(UsersIcon);
export const Volume2 = echoIcon(Volume2Icon);
export const X = echoIcon(XIcon);
